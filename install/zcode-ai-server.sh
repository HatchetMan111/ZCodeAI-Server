#!/usr/bin/env bash
# =============================================================================
#  ⚡ ZCode AI Server – One-Click-Installer (Proxmox VE)
#  https://github.com/HatchetMan111/ZCodeAI-Server
#
#  Erstellt einen unprivilegierten LXC-Container und baut/installiert darin das
#  ECHTE ZCode-Harness (Open-Source-Repo zai-org/ZCode, Apache 2.0) im
#  Web-Server-Modus: Browser-UI fürs ganze LAN, Z.ai-Konto-Login im Web-UI
#  (KEIN API-Key nötig), LAN-Zugriff per Access-Token.
#
#  Installation (auf dem Proxmox-Host als root):
#    bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-ai-server.sh)"
#
#  Mit Optionen (direkt hinter dem schließenden Anführungszeichen):
#    ... " --id 210 --memory 16384 --port 8090
#
#  Update / Deinstall / Status / Debug:
#    ... " --update        |  ... " --uninstall  |  ... " --status  |  ... " --debug
#
#  Hinweis: Der erste Lauf klont und baut die Agent-CLI (Node 24, pnpm) im
#  Container – das dauert je nach Leitung ~10–20 Minuten. --update wiederholt
#  denselben Lauf für die gepinnte Version (Daten bleiben erhalten).
# =============================================================================

# shellcheck disable=SC1111  # deutsche Anführungszeichen sind Absicht
set -Eeuo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────
APP_NAME="zcode-ai-server"
REPO_OWNER="HatchetMan111"
REPO_NAME="ZCodeAI-Server"
REPO_BRANCH="main"
ZCODE_VERSION="3.17.2"      # gepinnter Tag des offiziellen Repos zai-org/ZCode
NODE_VERSION="24.14.0"      # vom Harness geforderte Node-Version (mise.toml) – NICHT die ZCode-Version!
CT_ID=""                    # leer = automatisch nächste freie ID ab ID_SCAN_START
ID_SCAN_START=200
CT_HOSTNAME="zcode-ai-server"
CT_STORAGE="local-lvm"
CT_ROOTFS=32                # GB – Repo + node_modules + Dist + Workspaces
CT_CORES=4                  # Build im CT (vite/rolldown/tsc)
CT_MEMORY=8192              # MB – Build braucht Luft
CT_SWAP=0
CT_BRIDGE="vmbr0"
CT_IP="dhcp"
CT_GATEWAY=""               # nur bei statischer IP nötig, z. B. 192.168.1.1
CT_PASSWORD=""              # leer = automatisch generieren
PORT=8090                   # Web-UI-Port im Container
UNINSTALL=false
UPDATE=false
STATUS_CHECK=false
FORCE_RECREATE=false
ASSUME_YES=false
TMP_DIR=""
LOG_FILE="/tmp/${APP_NAME}-installer-$(date +%Y%m%d-%H%M%S).log"
# Der fertige Einzeiler für Hinweise/Fehlerausgaben – exakt kopierbar (Optionen
# hinter dem schließenden Anführungszeichen; der Installer erkennt sie via $0-Fallback)
ONE_LINER='bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-ai-server.sh)"'

# ── Farben & Logging ───────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

info()  { echo -e "${BLUE}ℹ${NC}  $1"; }
ok()    { echo -e "${GREEN}✔${NC}  $1"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $1"; }
err()   { echo -e "${RED}✘${NC}  $1" >&2; }
die()   { err "$1"; exit 1; }
header(){ echo -e "\n${CYAN}${BOLD}━━━ $1 ━━━${NC}"; }

# ── Vollständiges Log mitschneiden (Debugging-Anforderung) ─────────────────
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
exec > >(tee "$LOG_FILE") 2>&1

# ── Cleanup & Fehlerkette ──────────────────────────────────────────────────
cleanup() {
    # if statt [[ ]] && – sonst gibt cleanup() bei leerem TMP_DIR Exit-Code 1
    # zurück und überschreibt den eigentlichen Exit-Status des Scripts.
    if [[ -n "${TMP_DIR:-}" && -d "$TMP_DIR" ]]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT

# Gibt bei Fehlern die KOMPLETTE Fehlerkette aus: Zeile, Befehl, Exit-Code,
# letzte Logzeilen sowie Container-Logs (Build + Service), falls schon
# ein Container existiert.
on_error() {
    local ec=$1 line=$2 cmd=$3
    err "Installationsfehler – Exit-Code ${ec} in Zeile ${line}"
    err "Fehlgeschlagener Befehl: ${cmd}"
    if [[ -f "$LOG_FILE" ]]; then
        info "Letzte Logzeilen (${LOG_FILE}):"
        tail -n 20 "$LOG_FILE" | sed 's/^/    /' || true
    fi
    if [[ -n "${CT_ID:-}" ]] && pct status "$CT_ID" &>/dev/null; then
        info "Container-Logs (Build + Service):"
        pct exec "$CT_ID" -- sh -c '
            tail -n 40 /var/log/zcode-ai-setup.log 2>/dev/null
            echo "--- journalctl -u zcode-ai-server ---"
            journalctl -u zcode-ai-server --no-pager 2>/dev/null | tail -n 25
        ' 2>/dev/null | sed 's/^/    /' || true
        info "Container $CT_ID wurde NICHT gelöscht – Inspektion: pct enter $CT_ID"
        info "Aufräumen: pct stop $CT_ID && pct destroy $CT_ID --purge"
    fi
    info "Vollständiges Log: $LOG_FILE"
    info "Neu ausführen mit vollem bash -x-Trace (exakter Befehl):"
    echo "    ${ONE_LINER} --debug"
    exit "$ec"
}
trap 'on_error $? $LINENO "$BASH_COMMAND"' ERR

# ── Debug-Modus (voller bash -x-Trace) ─────────────────────────────────────
# (Vor parse_args, damit --debug selbst noch mitgetraced wird.)
if [[ "${1:-}" == "--debug" || "$0" == "--debug" ]]; then
    set -x
fi

# ── Hilfsfunktionen ────────────────────────────────────────────────────────
ct_exists() {
    # if statt [[ ]] && … – Rückgabewert sauber halten.
    # Name ist in `pct list` IMMER die letzte Spalte (Lock kann leer sein).
    if pct list 2>/dev/null | awk '{print $NF}' | grep -qx "${1:-}"; then
        return 0
    fi
    return 1
}

find_free_id() {
    local id="$ID_SCAN_START"
    while pct list 2>/dev/null | awk '{print $1}' | grep -qx "$id"; do
        id=$((id + 1))
    done
    echo "$id"
}

find_ct_id_by_hostname() {
    pct list 2>/dev/null | awk -v h="$CT_HOSTNAME" '$NF==h {print $1; exit}'
}

get_ct_ip() {
    # Grube (pipefail): bei pct-exec-Fehlschlag stirbt die Substitution –
    # deshalb || true INNERHALB von $().
    local ip=""
    ip=$(pct exec "$1" -- hostname -I 2>/dev/null | awk '{print $1}' || true)
    echo "$ip"
}

ensure_ct_running() {
    # Verwaltungs-Pfade (--update/--status) müssen einen GESTOPPTEN CT selbst
    # starten – pct exec auf gestopptem CT → Exit 255.
    local id="$1"
    if pct status "$id" 2>/dev/null | grep -q "status: running"; then
        return 0
    fi
    info "Container ist gestoppt – starte ihn ..."
    pct start "$id"
    wait_for_ct_network "$id"
}

wait_for_ct_network() {
    # Nach pct create --start nicht blind sleep 3 (DHCP/DNS-Race) – aktiv pollen.
    local id="$1" tries=0 ip=""
    info "Warte auf Netzwerk im Container (DHCP) ..."
    while true; do
        ip=$(get_ct_ip "$id")
        if [[ -n "$ip" ]]; then
            ok "Container-IP: $ip"
            return 0
        fi
        tries=$((tries + 1))
        if [[ $tries -ge 60 ]]; then
            err "Container hat nach 60 s keine IP bekommen."
            info "Prüfe: pct exec $id -- ip a   und DHCP am Bridge-Interface ($CT_BRIDGE)"
            return 1
        fi
        sleep 1
    done
}

verify_ct_dns() {
    # IP allein reicht nicht – Clone (github.com), Node-Download (nodejs.org)
    # und pnpm (registry.npmjs.org) brauchen Namensauflösung. DNS kann FLAKY
    # sein: 3 Erfolge in Folge verlangen; eine Störung → Fallback + Freeze.
    local id="$1" ok_count=0 tries=0
    info "Prüfe DNS im Container (3x hintereinander) ..."
    while true; do
        if pct exec "$id" -- getent hosts github.com >/dev/null 2>&1; then
            ok_count=$((ok_count + 1))
            if [[ $ok_count -ge 3 ]]; then
                ok "DNS im Container funktioniert (3x bestätigt)"
                return 0
            fi
        else
            ok_count=0
        fi
        tries=$((tries + 1))
        if [[ $tries -ge 10 ]]; then
            break
        fi
        sleep 2
    done
    # Fallback: DNS des Hosts (falls nicht loopback) + öffentliche Resolver eintragen
    local host_ns ns_list
    host_ns=$(grep -h '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | grep -v '^127\.' | head -1 || true)
    ns_list="1.1.1.1 8.8.8.8"
    if [[ -n "$host_ns" ]]; then
        ns_list="$host_ns $ns_list"
    fi
    warn "DNS im Container defekt – schreibe Fallback-Nameserver ($ns_list) nach /etc/resolv.conf"
    pct exec "$id" -- sh -c "printf 'nameserver %s\n' $ns_list > /etc/resolv.conf"
    # Dauerhaft: dhclient-Hook (verhindert das Überschreiben durch Lease-Renewals —
    # chattr +i funktioniert in unprivilegierten LXCs nicht) + nochmal prüfen.
    pct exec "$id" -- bash -c 'mkdir -p /etc/dhcp/dhclient-enter-hooks.d && printf "make_resolv_conf() { :; }\n" > /etc/dhcp/dhclient-enter-hooks.d/no-dns'
    if pct exec "$id" -- getent hosts github.com >/dev/null 2>&1; then
        ok "DNS-Fallback aktiv und gegen DHCP-Überschreiben geschützt – Auflösung funktioniert"
        return 0
    fi
    die "DNS im Container weiterhin ohne Funktion (auch mit Fallback).\n  Prüfe: pct exec $id -- getent hosts github.com nodejs.org registry.npmjs.org\n  Firewall/Router: ausgehende DNS-Anfragen (Port 53) am Bridge-Netz erlauben."
}

# ── Argumente parsen ───────────────────────────────────────────────────────
parse_args() {
    # Grube (bash -c): `bash -c "$(wget -qLO - URL)" --id 5` belegt das ERSTE
    # Argument nach dem Script-String mit $0, nicht $1 – die Option würde
    # still geschluckt. Fallback: startet $0 mit "-", ist es eine Option.
    local args=("$@")
    if [[ "$0" == -* ]]; then
        args=("$0" "$@")
    fi
    local i=0
    while [[ $i -lt ${#args[@]} ]]; do
        case "${args[$i]}" in
            --id)            CT_ID="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --hostname)      CT_HOSTNAME="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --storage)       CT_STORAGE="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --rootfs)        CT_ROOTFS="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --cores)         CT_CORES="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --memory)        CT_MEMORY="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --swap)          CT_SWAP="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --bridge)        CT_BRIDGE="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --ip)            CT_IP="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --gateway)       CT_GATEWAY="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --password)      CT_PASSWORD="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --port)          PORT="${args[$((i+1))]:-}"; i=$((i+2)) ;;
            --force)         FORCE_RECREATE=true; i=$((i+1)) ;;
            --yes|-y)        ASSUME_YES=true; i=$((i+1)) ;;
            --update)        UPDATE=true; i=$((i+1)) ;;
            --uninstall)     UNINSTALL=true; i=$((i+1)) ;;
            --status)        STATUS_CHECK=true; i=$((i+1)) ;;
            --debug)         set -x; i=$((i+1)) ;;
            --help|-h)       print_help; exit 0 ;;
            *) die "Unbekannte Option: ${args[$i]}  (–help zeigt alle Optionen)" ;;
        esac
    done
}

print_help() {
    cat <<EOF
⚡ ZCode AI Server – Proxmox-Installer (echtes ZCode-Harness im Web-Modus)

Installation:   bash -c "\$(wget -qLO - https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install/zcode-ai-server.sh)"

Optionen (hinter dem schließenden Anführungszeichen anhängen, z. B. ... " --id 210):
  --id ID          Container-ID (Default: nächste freie ab 200)
  --hostname NAME  Container-Hostname (Default: zcode-ai-server)
  --storage NAME   Storage für rootfs (Default: local-lvm)
  --rootfs GB      Disk-Größe (Default: 32 – Repo + node_modules + Workspaces)
  --cores N        vCPUs (Default: 4 – Build im Container!)
  --memory MB      RAM (Default: 8192 – Build braucht Luft)
  --bridge BR      Netzwerk-Bridge (Default: vmbr0)
  --ip CIDR        Statt DHCP, z. B. 192.168.1.50/24 (+ --gateway 192.168.1.1)
  --gateway GW     Gateway für statische IP
  --password PW    Root-Passwort (Default: automatisch generiert)
  --port PORT      Web-UI-Port im Container (Default: 8090)
  --force          Vorhandenen Container mit gleichem Hostname löschen und neu anlegen
  --yes / -y       Rückfragen überspringen
  --update         Harness im bestehenden Container neu bauen (Daten + Token bleiben)
  --uninstall      Container stoppen und löschen (inkl. Workspaces!)
  --status         Status anzeigen
  --debug          Vollständiges bash -x-Trace

  Modus:  Install (Default) / --update / --uninstall / --status / --debug
EOF
}

# ── In-Container-Setup-Script (idempotent) ─────────────────────────────────
write_inner_script() {
    cat > "$TMP_DIR/setup-inner.sh" <<INNEREOF
#!/usr/bin/env bash
# =============================================================================
# ZCode AI Server In-Container-Setup (idempotent – safe für Update & Re-Run)
# Baut das ECHTE ZCode-Harness aus zai-org/ZCode (Tag ${ZCODE_VERSION}) und
# installiert es als systemd-Web-Service.
# =============================================================================
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C   # verhindert perl/locale-Warnungen im frischen Debian-CT

echo ">>> Basis-Pakete (git, curl, xz, openssl, build-essential) ..."
apt-get update -qq
# build-essential: node-pty (Workspace) hat kein linux-x64-Prebuild im
# npm-Release → pnpm-Postinstall kompiliert per node-gyp (make/g++ nötig);
# ebenso cpu-features (ssh2). python3 ist im Debian-Template enthalten.
apt-get install -y -qq git curl ca-certificates xz-utils tar openssl procps build-essential >/dev/null

echo ">>> Installer-Tarball laden (systemd-Unit aus diesem Repo) ..."
# Erst NACH dem apt-install – das nackte Debian-Template hat kein curl!
curl -fsSL --retry 3 "https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/refs/heads/${REPO_BRANCH}" -o /tmp/zcode-ai-installer.tar.gz
rm -rf /tmp/zcode-ai-src && mkdir -p /tmp/zcode-ai-src
tar -xzf /tmp/zcode-ai-installer.tar.gz -C /tmp/zcode-ai-src --strip-components=1

echo ">>> Nameserver festschreiben (DHCP-DNS des Netzes kann flaky sein) ..."
mkdir -p /etc/dhcp/dhclient-enter-hooks.d
printf '# ZCode AI Server: resolv.conf nicht von DHCP überschreiben lassen\nmake_resolv_conf() { :; }\n' > /etc/dhcp/dhclient-enter-hooks.d/no-dns
printf 'domain home.arpa\nsearch home.arpa\nnameserver %s\nnameserver 1.1.1.1\nnameserver 8.8.8.8\n' "${HOST_DNS:-1.1.1.1}" > /etc/resolv.conf

echo ">>> Node.js ${NODE_VERSION} installieren (offizielles Binary nach /opt/node24) ..."
if [[ ! -x /opt/node24/bin/node ]] || ! /opt/node24/bin/node --version 2>/dev/null | grep -q "^v${NODE_VERSION}"; then
    curl -fSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz"
    curl -fsSL --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o /tmp/node-SHASUMS.txt
    # sha256sum -c löst Namen RELATIV ZUM CWD auf (inner läuft in /root, Datei
    # liegt in /tmp) → Ziel-Pfad direkt in die Checksummen-Zeile schreiben.
    NODE_SUM=\$(awk -v f="node-v${NODE_VERSION}-linux-x64.tar.xz" '\$2==f {print \$1}' /tmp/node-SHASUMS.txt)
    if [[ -z "\$NODE_SUM" ]]; then
        echo "FEHLER: node-v${NODE_VERSION}-linux-x64.tar.xz fehlt in SHASUMS256.txt"; exit 9
    fi
    echo "\${NODE_SUM}  /tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" | sha256sum -c -
    rm -rf /opt/node24
    mkdir -p /opt/node24
    tar -xJf "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" -C /opt/node24 --strip-components=1
    rm -f "/tmp/node-v${NODE_VERSION}-linux-x64.tar.xz" /tmp/node-SHASUMS.txt
fi
export PATH="/opt/node24/bin:\$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
/opt/node24/bin/node --version
corepack enable --install-directory /opt/node24/bin
corepack prepare pnpm@10.33.2 --activate
pnpm --version

echo ">>> ZCode-Quelle klonen (zai-org/ZCode @ v${ZCODE_VERSION}) ..."
rm -rf /opt/zcode-ai/src
# GitHub-Tags tragen ein v-Prefix: ZCODE_VERSION=3.17.2 → Tag v3.17.2
git clone --depth 1 --branch "v${ZCODE_VERSION}" https://github.com/zai-org/ZCode.git /opt/zcode-ai/src
cd /opt/zcode-ai/src

echo ">>> Workspace-Abhängigkeiten installieren (gefiltert – ohne Desktop/Electron) ..."
pnpm install \
    --filter "@zcode/cli..." \
    --filter "@zcode/server" \
    --filter "@zcode/web" \
    --filter "@zcode/services..." \
    --filter "@zcode/ui..." \
    --filter "@zcode/client..." \
    --filter @zcode/zcode-cua \
    --filter . \
    --config.confirmModulesPurge=false

echo ">>> @zcode/shared-Dist erzeugen (benötigt vom TUI-Staging) ..."
./node_modules/.bin/tsc -p packages/shared/tsconfig.json

echo ">>> ZCode-CLI-Dist bauen (Web + Server + Agent) – dauert einige Minuten ..."
node scripts/build-zcode.mjs --base-url http://localhost/zcode/ --version "${ZCODE_VERSION}"

echo ">>> Runtime installieren (Layout wie das offizielle install.sh) ..."
mkdir -p /opt/zcode-ai/runtime/releases /opt/zcode-ai/{data,workspaces}
REL_DIR="/opt/zcode-ai/runtime/releases/${ZCODE_VERSION}"
rm -rf "\${REL_DIR}.new" && mkdir -p "\${REL_DIR}.new"
tar -xzf "dist/zcode/releases/${ZCODE_VERSION}/zcode-${ZCODE_VERSION}.tar.gz" -C "\${REL_DIR}.new"
rm -rf "\$REL_DIR"
mv "\${REL_DIR}.new/zcode" "\$REL_DIR"
rmdir "\${REL_DIR}.new"
ln -sfn "\$REL_DIR" /opt/zcode-ai/runtime/current
cat > /usr/local/bin/zcode <<'WRAP'
#!/usr/bin/env sh
exec /opt/node24/bin/node /opt/zcode-ai/runtime/current/bin/zcode.mjs "$@"
WRAP
chmod +x /usr/local/bin/zcode
/opt/node24/bin/node /opt/zcode-ai/runtime/current/bin/zcode.mjs --version

echo ">>> Access-Token sicherstellen (bleibt über Updates/Reboots stabil) ..."
if [[ ! -s /opt/zcode-ai/data/access-token ]]; then
    openssl rand -hex 16 > /opt/zcode-ai/data/access-token
fi
chmod 600 /opt/zcode-ai/data/access-token
ACCESS_TOKEN=\$(cat /opt/zcode-ai/data/access-token)

echo ">>> systemd-Unit installieren (aus dem Installer-Tarball) ..."
install -m 600 /tmp/zcode-ai-src/app/zcode-ai-server.service /etc/systemd/system/zcode-ai-server.service
sed -i "s/^ExecStart=.*/ExecStart=\/opt\/node24\/bin\/node \/opt\/zcode-ai\/runtime\/current\/bin\/zcode.mjs --web --host 0.0.0.0 --port ${PORT} --workspace \/opt\/zcode-ai\/workspaces --token \${ACCESS_TOKEN}/" /etc/systemd/system/zcode-ai-server.service
systemctl daemon-reload

# Aufräumen erst NACH allen installs
rm -rf /tmp/zcode-ai-src /tmp/zcode-ai-installer.tar.gz

echo ">>> Service aktivieren ..."
systemctl enable --now zcode-ai-server.service

echo ">>> Setup abgeschlossen."
INNEREOF
}

run_inner_setup() {
    local ct_id="$1"
    header "⚙️  Klonen + Bauen im Container $ct_id (Node 24 + pnpm + vite – ca. 10–20 min)"
    # DNS des Hosts in den Container bringen (dort resolvert das Setup garantiert –
    # der DHCP-DNS des Zielnetzes kann flaky sein, siehe verify_ct_dns)
    HOST_DNS=$(grep -h '^nameserver' /etc/resolv.conf 2>/dev/null \
               | awk '{print $2}' | grep -v '^127\.' | head -1 || true)
    write_inner_script
    pct push "$ct_id" "$TMP_DIR/setup-inner.sh" /root/setup-inner.sh
    # ALLES läuft im inner-Script (inkl. curl-Install + Tarball-Download) –
    # das nackte Debian-Template hat kein curl, pct exec curl → Exit 127!
    # Grube (tee-Pipe): ohne exit ${PIPESTATUS[0]} frisst die Pipe den inner-
    # Exit-Code (Fehler im inner liefen als "erfolgreich" durch!).
    pct exec "$ct_id" -- bash -c "bash /root/setup-inner.sh 2>&1 | tee /var/log/zcode-ai-setup.log; exit \${PIPESTATUS[0]}"
}

# ── Verifikation ───────────────────────────────────────────────────────────
verify_installation() {
    local ct_id="$1" tries=0 code=""

    header "✅ Verifikation"

    # Service aktiv?
    while true; do
        if pct exec "$ct_id" -- systemctl is-active --quiet zcode-ai-server.service 2>/dev/null; then
            ok "Service zcode-ai-server.service läuft"
            break
        fi
        tries=$((tries + 1))
        if [[ $tries -ge 30 ]]; then
            die "Service zcode-ai-server.service läuft nicht.\n  Debug: pct exec $ct_id -- journalctl -u zcode-ai-server -e"
        fi
        sleep 1
    done

    # Web-UI antwortet? (/health – ohne Token erreichbar; Access-Schutz liegt
    # auf der API-Schicht. Grube: curl -w gibt bei Verbindungsfehler bereits
    # 000 aus – NIE zusätzlich || echo 000 anhängen, sonst falsch-positiv.)
    tries=0
    while true; do
        code=$(pct exec "$ct_id" -- curl -s -o /dev/null -w '%{http_code}' \
               "http://127.0.0.1:${PORT}/health" || true)
        if [[ "$code" == "200" ]]; then
            ok "Web-UI antwortet (HTTP 200 auf /health)"
            break
        fi
        tries=$((tries + 1))
        if [[ $tries -ge 30 ]]; then
            die "Web-UI antwortet nicht (letzter HTTP-Code: ${code:-unbekannt}).\n  Debug: pct exec $ct_id -- journalctl -u zcode-ai-server -e"
        fi
        sleep 1
    done
}

# ── Zusammenfassung ────────────────────────────────────────────────────────
print_summary() {
    header "⚡  ZCode AI Server ist bereit!"

    local ct_ip access_token
    ct_ip=$(get_ct_ip "$CT_ID")
    if [[ -z "$ct_ip" ]]; then
        ct_ip="<IP-ADRESSE>"
    fi
    access_token=$(pct exec "$CT_ID" -- cat /opt/zcode-ai/data/access-token 2>/dev/null || true)
    if [[ -z "$access_token" ]]; then
        access_token="<TOKEN-SIEHE-CONTAINER: cat /opt/zcode-ai/data/access-token>"
    fi

    echo ""
    echo -e "  ${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo -e "  ${GREEN}  🌐 Web-UI:    http://${ct_ip}:${PORT}/?token=${access_token}${NC}"
    echo -e "  ${GREEN}  🔑 Token:     ${access_token}${NC}"
    echo -e "  ${GREEN}  🐚 Terminal:  pct enter ${CT_ID}${NC}"
    if [[ -n "$CT_PASSWORD" ]]; then
        echo -e "  ${GREEN}  🔒 Root-PW:   ${CT_PASSWORD}${NC}"
    fi
    echo -e "  ${GREEN}  💾 Workspaces: /opt/zcode-ai/workspaces  (im Container)${NC}"
    echo -e "  ${GREEN}  🧬 Harness:    zai-org/ZCode @ ${ZCODE_VERSION} (Apache 2.0)${NC}"
    echo -e "  ${GREEN}${BOLD}════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${CYAN}So geht's weiter (KEIN API-Key nötig):${NC}"
    echo "  1. Web-UI-URL (mit ?token=…) im Browser öffnen"
    echo "  2. „Connect to Z.ai“ wählen und mit deinem Z.ai-Konto anmelden"
    echo "  3. Aufgabe beschreiben – der Agent läuft im Container, UI im Browser"
    echo ""
    echo -e "  ${CYAN}Nützliche Befehle (exakt kopierbar):${NC}"
    echo "  Status:    ${ONE_LINER} --status"
    echo "  Update:    ${ONE_LINER} --update"
    echo "  Deinstall: ${ONE_LINER} --uninstall"
    echo "  Token:     pct exec ${CT_ID} -- cat /opt/zcode-ai/data/access-token"
    echo "  Logs:      pct exec ${CT_ID} -- journalctl -u zcode-ai-server -f"
    echo ""
    warn "Hinweis: der Agent führt Befehle IM CONTAINER aus (Isolation durch LXC)."
    warn "Port ${PORT} nicht ohne Absicherung ins Internet exposen."
}

# ── Install ────────────────────────────────────────────────────────────────
do_install() {
    header "⚡ Installiere ZCode AI Server (LXC, echtes Harness @ ${ZCODE_VERSION})"

    if [[ $EUID -ne 0 ]]; then
        die "Bitte als root ausführen (auf dem Proxmox-Host)."
    fi
    if ! command -v pct >/dev/null 2>&1; then
        die "pct nicht gefunden – das Script muss auf einem Proxmox-VE-Host laufen."
    fi

    # Bereits vorhanden? ALLE Treffer listen (doppelte Hostnamen = Warnfall)
    local all_ids existing
    all_ids=$(pct list 2>/dev/null | awk -v h="$CT_HOSTNAME" '$NF==h {print $1}' | tr '\n' ' ' | sed 's/ $//')
    if [[ -n "$all_ids" ]]; then
        existing=${all_ids%% *}
        if [[ "$all_ids" == *" "* ]]; then
            warn "MEHRERE Container mit Hostname '$CT_HOSTNAME': $all_ids"
            warn "--force löscht nur $existing – überzählige vorher manuell räumen:"
            warn "  pct stop <ID> && pct destroy <ID> --purge   (für jede doppelte ID)"
        fi
        if $FORCE_RECREATE; then
            warn "Container $existing ($CT_HOSTNAME) existiert – --force: lösche und lege neu an (nächste freie ID)."
            warn "ALLE Workspaces/Sessions in diesem Container gehen verloren!"
            pct stop "$existing" || true
            pct destroy "$existing" --purge
        else
            die "Container $all_ids mit Hostname '$CT_HOSTNAME' existiert bereits.\n  Update (dasselbe CT, Daten bleiben):  ${ONE_LINER} --update\n  Neu aufsetzen (löscht CT, wählt nächste freie ID):  ${ONE_LINER} --force\n  Doppelte manuell räumen:  pct stop <ID> && pct destroy <ID> --purge"
        fi
    fi

    # Debian-Template sicherstellen
    header "🧱 Container-Template"
    local template=""
    template=$(pveam list local 2>/dev/null | awk '{print $1}' | grep -o 'debian-12-standard[^ ]*' | sort -rV | head -1 || true)
    if [[ -z "$template" ]]; then
        info "Kein Debian-12-Template vorhanden – lade es herunter ..."
        pveam update
        template=$(pveam available --section system 2>/dev/null | grep -o 'debian-12-standard[^ ]*' | sort -rV | head -1 || true)
        if [[ -z "$template" ]]; then
            die "Kein debian-12-standard-Template gefunden (pveam available leer?)."
        fi
        pveam download local "$template"
    fi
    ok "Template: $template"

    # ID & Passwort
    if [[ -z "$CT_ID" ]]; then
        CT_ID=$(find_free_id)
        info "Nächste freie CT-ID: $CT_ID"
    fi
    if [[ -z "$CT_PASSWORD" ]]; then
        CT_PASSWORD=$(openssl rand -base64 12 2>/dev/null || true)
        if [[ -z "$CT_PASSWORD" ]]; then
            CT_PASSWORD="zc-$(date +%s)"
        fi
    fi

    # Container anlegen
    header "🚀 Erzeuge Container $CT_ID ($CT_HOSTNAME)"
    local net0="name=eth0,bridge=${CT_BRIDGE},ip=${CT_IP},firewall=0"
    if [[ -n "$CT_GATEWAY" ]]; then
        net0+=",gateway=${CT_GATEWAY}"
    fi
    pct create "$CT_ID" "local:vztmpl/${template}" \
        --hostname "$CT_HOSTNAME" \
        --cores "$CT_CORES" \
        --memory "$CT_MEMORY" \
        --swap "$CT_SWAP" \
        --rootfs "${CT_STORAGE}:${CT_ROOTFS}" \
        --net0 "$net0" \
        --unprivileged 1 \
        --features nesting=1 \
        --onboot 1 \
        --start 1 \
        --password "$CT_PASSWORD"
    ok "Container $CT_ID erstellt und gestartet"

    wait_for_ct_network "$CT_ID"
    verify_ct_dns "$CT_ID"

    run_inner_setup "$CT_ID"
    verify_installation "$CT_ID"
    print_summary
}

# ── Update ─────────────────────────────────────────────────────────────────
do_update() {
    header "🔄 Update ZCode AI Server (neu bauen @ ${ZCODE_VERSION})"

    local ct_id
    ct_id=$(find_ct_id_by_hostname || true)
    if [[ -z "$ct_id" ]]; then
        die "Kein Container mit Hostname '$CT_HOSTNAME' gefunden.\n  Erst installieren:  ${ONE_LINER}"
    fi
    CT_ID="$ct_id"

    ensure_ct_running "$ct_id"
    verify_ct_dns "$ct_id"

    run_inner_setup "$ct_id"
    verify_installation "$ct_id"

    ok "Update abgeschlossen – workspaces/, data/ (inkl. Access-Token) blieben erhalten."
    print_summary
}

# ── Uninstall ──────────────────────────────────────────────────────────────
do_uninstall() {
    header "🗑️  Deinstalliere ZCode AI Server"

    local ct_id
    ct_id=$(find_ct_id_by_hostname || true)
    if [[ -z "$ct_id" ]]; then
        warn "Kein Container mit Hostname '$CT_HOSTNAME' gefunden – nichts zu tun."
        return 0
    fi
    CT_ID="$ct_id"

    warn "Container $ct_id ($CT_HOSTNAME) wird GESTOPPT und GELÖSCHT."
    warn "Darin: alle Workspaces (/opt/zcode-ai/workspaces), Sessions und der Access-Token!"
    if ! $ASSUME_YES; then
        local answer=""
        if ! read -r -t 60 -p "Wirklich löschen? (ja/NEIN): " answer; then
            die "Keine Bestätigung erhalten (nicht-interaktiv?) – nichts gelöscht.\n  Erzwingen:  ${ONE_LINER} --uninstall --yes"
        fi
        if [[ "$answer" != "ja" ]]; then
            info "Abgebrochen – nichts gelöscht."
            return 0
        fi
    fi
    pct stop "$ct_id" || true
    pct destroy "$ct_id" --purge
    ok "Container $ct_id entfernt."
}

# ── Status ─────────────────────────────────────────────────────────────────
do_status() {
    header "📊 Status ZCode AI Server"

    local ct_id
    ct_id=$(find_ct_id_by_hostname || true)
    if [[ -z "$ct_id" ]]; then
        warn "Kein Container mit Hostname '$CT_HOSTNAME' gefunden."
        info "Installieren:  ${ONE_LINER}"
        return 0
    fi
    CT_ID="$ct_id"

    pct list 2>/dev/null | awk -v id="$ct_id" '$1==id {print "Container:  " $1 " (" $2 ") – " $3 " – " $4 " – " $5}'
    # --status startet einen gestoppten Container NICHT – nur melden.
    if ! pct status "$ct_id" 2>/dev/null | grep -q "status: running"; then
        warn "Container ist gestoppt – Web-UI/Service nicht erreichbar."
        info "Starten:  pct start $ct_id   |   Update inkl. Start:  ${ONE_LINER} --update"
        return 0
    fi
    if pct exec "$ct_id" -- systemctl is-active --quiet zcode-ai-server.service 2>/dev/null; then
        ok "Service:   zcode-ai-server.service läuft"
    else
        err "Service:   zcode-ai-server.service läuft NICHT"
        info "Logs:      pct exec $ct_id -- journalctl -u zcode-ai-server -e"
    fi

    local ip code
    ip=$(get_ct_ip "$ct_id")
    if [[ -n "$ip" ]]; then
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${ip}:${PORT}/health" || true)
        if [[ "$code" == "200" ]]; then
            ok "Web-UI:    http://${ip}:${PORT}  (HTTP 200 – Zugriff mit ?token=…)"
        else
            warn "Web-UI:    HTTP-Code ${code:-unbekannt} von http://${ip}:${PORT}"
        fi
        local token
        token=$(pct exec "$ct_id" -- cat /opt/zcode-ai/data/access-token 2>/dev/null || true)
        if [[ -n "$token" ]]; then
            info "Token-URL: http://${ip}:${PORT}/?token=${token}"
        fi
    else
        warn "Container hat keine IP (läuft er?)."
    fi

    local harness
    harness=$(pct exec "$ct_id" -- sh -c '/opt/node24/bin/node /opt/zcode-ai/runtime/current/bin/zcode.mjs --version 2>/dev/null || echo unbekannt' 2>/dev/null || true)
    info "Harness:   zcode ${harness:-unbekannt} (zai-org/ZCode)"
}

# ── Main ───────────────────────────────────────────────────────────────────
parse_args "$@"

TMP_DIR=$(mktemp -d)

if $UNINSTALL; then
    do_uninstall
elif $UPDATE; then
    do_update
elif $STATUS_CHECK; then
    do_status
else
    do_install
fi
