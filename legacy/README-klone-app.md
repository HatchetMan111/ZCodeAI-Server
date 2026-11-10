# ⚡ ZCode-Server – Proxmox-Installer

Lokale **KI-Coding-Agent-Web-App im Stil von [zcode.z.ai](https://zcode.z.ai)** – als LXC-Container auf Proxmox VE, installiert mit einem Einzeiler im Stil der [Proxmox VE Community Scripts](https://community-scripts.github.io/ProxmoxVE).

> Warum diese App? zcode.z.ai selbst ist nur als Desktop-App verfügbar (kein CLI, kein Self-Hosting).
> ZCode-Server bringt das Erlebnis als **Server-Anwendung** ins eigene Netz: Agent-Chat mit
> Datei-Tools, Diffs, Bash-Ausführung im Workspace und Session-Verlauf – lokal, im Browser,
> von allen Geräten im LAN erreichbar.

---

## 🚀 Installation (auf dem Proxmox-Host als root)

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-server.sh)"
```

Das Script:

- nimmt die **nächste freie CT-ID ab 200** (bzw. `--id N`)
- erstellt einen **unprivilegierten LXC** (`zcode-server`, Debian 12, 2 vCPU / 4 GB RAM / 16 GB Disk, `onboot=1`)
- installiert Node.js (Debian-Repo) + die App aus diesem Repo
- richtet den **systemd-Service** ein (`Restart=always`, reboot-sicher)
- prüft selbst: Service läuft + Web-UI antwortet (HTTP 200 auf `/api/health`)
- gibt die finale URL aus

**Optionen** (hinter dem schließenden Anführungszeichen anhängen):

```bash
... " --id 210 --port 8090 --rootfs 32 --memory 4096 --ip 192.168.1.50/24 --gateway 192.168.1.1
```

## 🔑 Erste Schritte

1. `http://<CT-IP>:8090` öffnen
2. **⚙️ Einstellungen** → API-Endpoint wählen (Default: `https://api.z.ai/api/coding/paas/v4` – Z.ai GLM Coding Plan) und den **API-Key** eintragen (z.ai → API-Keys). Alternativ jede OpenAI-kompatible URL: Z.ai Pay-as-you-go (`https://api.z.ai/api/paas/v4`), OpenRouter (`https://openrouter.ai/api/v1`) oder **Ollama lokal** (`http://<host>:11434/v1`) → dann läuft alles komplett ohne Cloud.
3. **„Verbindung testen"** → links einen **Workspace** anlegen → Aufgabe beschreiben.

Der Agent kann im gewählten Workspace: Verzeichnisse lesen (`list_dir`), Dateien lesen/schreiben/gezielt editieren (`read_file`/`write_file`/`edit_file`, mit Diff-Anzeige) und **Bash-Befehle ausführen** (`run_command`, Output + Exit-Code sichtbar). Standard-Modell: `glm-5.3`, alternativ `glm-5.3-flash`/`glm-4.6` oder aus dem Modell-Dialog.

**Bestätigungsmodus** (ab Werk aktiv, wie „Ask before changes" in zcode.z.ai): jeder Bash-Befehl muss im UI freigegeben werden. Zusätzlich blockiert eine Blocklist gefährliche Befehle (`rm -rf /`, `mkfs`, `dd of=/dev/…`, Fork-Bomben, Pipe-to-Shell …) und jeder Befehl läuft mit Timeout im Container-Isolierten Workspace.

## 🔧 Verwaltung

```bash
# Status (Container, Service, Health-JSON, Workspaces)
... " --status

# Update: App im Container aktualisieren – Workspaces, Sessions und API-Key bleiben erhalten
... " --update

# Deinstall (Container stoppen + löschen, Rückfrage mit --yes überspringbar)
... " --uninstall

# Debug: komplettes bash -x-Trace (bei Fehlern wird zusätzlich die volle
# Fehlerkette mit Log-Tail + Container-Logs ausgegeben)
... " --debug
```

Exakt kopierbare Langform (Modus hinter dem schließenden Anführungszeichen):

```bash
bash -c "$(wget -qLO - https://raw.githubusercontent.com/HatchetMan111/ZCodeAI-Server/main/install/zcode-server.sh)" --update
```

## 🧱 Architektur

```
Browser ──http──▶ LXC "zcode-server" (Debian 12, unprivileged, onboot=1)
                    ├─ systemd: zcode-server.service  (0.0.0.0:8090)
                    │    ├─ app/server.js   – pure Node-Backend (keine npm-Deps)
                    │    │    • Agent-Loop: OpenAI-kompatible /chat/completions (streaming)
                    │    │    • Tools: list_dir / read_file / write_file / edit_file / run_command / finish
                    │    │    • Workspaces-Sandbox: /opt/zcode-server/workspaces/<name>
                    │    │    • Settings + Sessions: /opt/zcode-server/data (JSON)
                    │    └─ app/static      – gebaut React+Vite-Frontend (dieses Repo)
                    └─ Daten bleiben bei --update erhalten; Container löschen = alles weg
```

- **Reboot-sicher:** Container `onboot=1`, Service `Restart=always`, `After=network-online.target`.
- **Kein npm im Container:** das Frontend wird im Repo mitgeliefert (`app/static`), das Backend braucht nur das Debian-`nodejs`.
- **Sicherheit:** Agent-Befehle laufen im unprivilegierten LXC, Pfade sind auf den Workspace beschränkt, Blocklist + Bestätigungsmodus + Timeouts aktiv. Der API-Key liegt nur im Container (`data/settings.json`, chmod 600) und verlässt ihn nur Richtung LLM-Endpoint.

## 🐞 Debugging

- Install-Fehler: der Installer gibt die **komplette Fehlerkette** aus (Zeile, Befehl, Exit-Code, Log-Tail, Container-Logs) und löscht den Container nicht – Inspektion per `pct enter <ID>`.
- Neustart mit vollem Trace: `... " --debug`
- Service-Logs: `pct exec <ID> -- journalctl -u zcode-server -f`
- Health (Wahrheitsquelle): `curl http://<CT-IP>:8090/api/health`

## ⚠️ Haftung

Das Projekt ist ein privates Hobby-Tool ohne Garantie. Der Agent kann Code ausführen –
die Isolation hängt von deinem Proxmox-Setup ab. Öffne den Port nicht ohne Absicherung
ins Internet.

## Lizenz

MIT – siehe [LICENSE](LICENSE).
