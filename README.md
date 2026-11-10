# ⚡ ZCode AI Server – Proxmox-Installer (echtes ZCode-Harness)

Das **echte ZCode-Harness** (das Open-Source-Repo [zai-org/ZCode](https://github.com/zai-org/ZCode), Apache 2.0) als **Server-Anwendung** auf Proxmox VE – installiert mit einem Einzeiler im Stil der [Proxmox VE Community Scripts](https://community-scripts.github.io/ProxmoxVE).

**Kein API-Key nötig:** der Modell-Zugang läuft über den **Z.ai-Konto-Login** direkt im Web-UI („Connect to Z.ai"), wie in der Desktop-App. Der LAN-Zugriff ist per **Access-Token** geschützt, den der Installer ausgibt.

> Was das ist: die Agent-CLI des offiziellen ZCode-Repos im Web-Server-Modus
> (`zcode --web --host 0.0.0.0`) – dasselbe Harness wie in der Desktop-App
> (Agent, Terminal, Git, Datei-Tools), nur mit Browser-UI. Die CLI wird im
> LXC aus dem gepinnten Tag gebaut (Node 24 + pnpm, gefiltert ohne
> Desktop/Electron-Ballast) und als systemd-Service betrieben.
>
> Historie: `legacy/` enthält die frühere selbst gebaute Agent-Web-App
> (Klon-Experiment) – ersetzt durch dieses echte Harness.

---

## 🚀 Installation (auf dem Proxmox-Host als root)

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-ai-server.sh)"
```

Das Script:

- nimmt die **nächste freie CT-ID ab 200** (bzw. `--id N`)
- erstellt einen **unprivilegierten LXC** (`zcode-ai-server`, Debian 12, **4 vCPU / 8 GB RAM / 32 GB Disk**, `onboot=1`)
- installiert Node 24.14.0 (offizielles Binary + SHA256-Prüfung) und klont `zai-org/ZCode` @ **v3.17.2**
- baut die CLI-Dist im Container (gefilterte Workspace-Install **ohne Electron**) – dauert ~10–20 min
- richtet den **systemd-Service** ein (`Restart=always`, reboot-sicher, fixer Access-Token)
- prüft selbst: Service läuft + Web-UI antwortet (HTTP 200 auf `/health`)
- gibt die **fertige URL inkl. `?token=…`** aus

**Optionen** (hinter dem schließenden Anführungszeichen anhängen):

```bash
... " --id 210 --port 8090 --memory 16384 --rootfs 64 --ip 192.168.1.50/24 --gateway 192.168.1.1
```

## 🔑 Erste Schritte (ohne API-Key)

1. Die ausgegebene URL öffnen: `http://<CT-IP>:8090/?token=<ACCESS-TOKEN>`
2. **„Connect to Z.ai"** wählen und mit dem Z.ai-Konto anmelden (wie in der Desktop-App; alternativ „Use API key")
3. Aufgabe beschreiben – der Agent läuft im Container (`/opt/zcode-ai/workspaces`), die UI im Browser

Der Access-Token liegt im Container unter `/opt/zcode-ai/data/access-token` (chmod 600), bleibt über Updates und Reboots stabil und schützt die API/WebSocket-Schicht. Ohne gültigen Token lädt zwar die Seite, aber die Agent-Kommunikation ist blockiert.

## 🔧 Verwaltung

```bash
# Status (Container, Service, Health, Harness-Version, Token-URL)
... " --status

# Update: Harness für die gepinnte Version neu bauen – Workspaces/Daten/Token bleiben
# (neue ZCode-Version: ZCODE_VERSION oben im Installer ändern, dann --update)
... " --update

# Deinstall (Container stoppen + löschen, Rückfrage mit --yes überspringbar)
... " --uninstall

# Debug: komplettes bash -x-Trace (bei Fehlern wird zusätzlich die volle
# Fehlerkette mit Log-Tail + Container-Logs ausgegeben)
... " --debug
```

Exakt kopierbare Langform (Modus hinter dem schließenden Anführungszeichen):

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-ai-server.sh)" --update
```

## 🧱 Architektur

```
Browser (LAN) ──http──▶ LXC "zcode-ai-server" (Debian 12, unprivileged, 4 vCPU/8 GB, onboot=1)
                          ├─ systemd: zcode-ai-server.service
                          │    ExecStart: /opt/node24/bin/node
                          │      /opt/zcode-ai/runtime/current/bin/zcode.mjs
                          │      --web --host 0.0.0.0 --port 8090
                          │      --workspace /opt/zcode-ai/workspaces --token <ACCESS-TOKEN>
                          ├─ /opt/zcode-ai/runtime  – gebaute Dist (web/, server/, agent/)
                          ├─ /opt/zcode-ai/src      – Clone zai-org/ZCode @ v3.17.2
                          ├─ /opt/zcode-ai/data     – Sessions/Config + access-token
                          └─ /opt/zcode-ai/workspaces – Agent-Arbeitsverzeichnisse
```

- **Quelle:** [zai-org/ZCode](https://github.com/zai-org/ZCode) (Apache 2.0), Tag `v3.17.2` gepinnt (`ZCODE_VERSION` oben im Installer)
- **Build im CT:** `pnpm install --filter …` (ohne `@zcode/desktop` → kein Electron) + `tsc -p packages/shared` + `node scripts/build-zcode.mjs`
- **Runtime:** eigenes node_modules (inkl. `@lydell/node-pty-linux-x64`-Prebuilds), nur System-Node nötig
- **Reboot-sicher:** CT `onboot=1`, Service `Restart=always`, `After=network-online.target`
- **Sicherheit:** Agent läuft im unprivilegierten LXC; Token schützt die API; Port nicht ohne Absicherung ins Internet exposen

## 🐞 Debugging

- Install-Fehler: der Installer gibt die **komplette Fehlerkette** aus (Zeile, Befehl, Exit-Code, Log-Tail, Container-Logs) und löscht den Container nicht – Inspektion per `pct enter <ID>`
- Build-Log im Container: `pct exec <ID> -- tail -n 100 /var/log/zcode-ai-setup.log`
- Service-Logs: `pct exec <ID> -- journalctl -u zcode-ai-server -f`
- Health (Wahrheitsquelle): `curl http://<CT-IP>:8090/health`
- Neustart mit vollem Trace: `... " --debug`

## ⚠️ Haftung

Privates Hobby-Tool ohne Garantie. Der Agent kann Code im Container ausführen.
Nutzung des ZCode-Harness unterliegt den Z.ai-Nutzungsbedingungen (GLM-Plan/Konto).

## Lizenz

MIT für diese Installer-Repos-Dateien – das Harness selbst: Apache 2.0 ([zai-org/ZCode](https://github.com/zai-org/ZCode)). Siehe [LICENSE](LICENSE).
