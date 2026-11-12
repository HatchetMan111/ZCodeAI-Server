# Patches für zai-org/ZCode v3.17.2

Der Installer klont upstream **exakt** `v3.17.2` und wendet danach diese drei
Patches an (`git apply`, direkt nach dem Clone). Sie beheben drei Fehler, ohne
die der Web-Modus nicht benutzbar ist – alle drei wurden reproduziert und nach
dem Fix im echten Browser (Playwright, LAN-IP **und** `127.0.0.1`) gegengeprüft.

Reihenfolge ist relevant; die Dateien werden alphabetisch angewendet.

## 0001-local-project-host.patch

**Symptom:** Ordner-Dialog zeigt „Failed to get system info“, „Create project“
scheitert, Chat-Senden scheitert mit einer Meldung zum Projekt-Kontext.

**Ursache:** `createServerHostServices()` speichert Projekte im Standalone-Web-
Server unter der synthetischen Host-ID `remote:server:<serverId>`. Die Web-UI
sendet aber immer `hostId: "local"`. Ergebnis:

- `project.host-offline` → Verzeichnisliste/System-Info schlägt fehl
- `project.host-immutable` → Projekt anlegen schlägt fehl
- `project.remote-project-required` → Draft-Session/Senden schlägt fehl

**Fix:** Neue Option `localProjectHost` (nutzt `"local"` als
`projectStorageHostId`); `packages/server/src/entry-http.ts` setzt sie.

## 0002-insecure-context-crypto.patch

**Symptom:** Senden im LAN (`http://<IP>:8090`) scheitert mit „Failed to send.
Try again later.“; Details: „草稿会话创建失败，请重试“. Auf
`http://127.0.0.1:8090` funktioniert dasselbe.

**Ursache:** `http://<IP>` ist kein *Secure Context*. Dort ist
`crypto.randomUUID` im Browser `undefined`; der Composer/Command-Pfad ruft es
ungeschützt auf, wodurch die Draft-Session schon clientseitig scheitert.

**Fix:** `packages/web/src/insecureContextCryptoPolyfill.ts` definiert
`crypto.randomUUID` aus `getRandomValues` (auch unsicher verfügbar) und wird als
erstes Modul in `packages/web/src/main.tsx` geladen.

> `crypto.subtle` ist nicht polyfillbar. Anhang-Upload/-Einfügen braucht deshalb
> weiterhin HTTPS oder `localhost` (SSH-Tunnel). Siehe Haupt-README.

## 0003-create-directory.patch

**Symptom:** Es gibt im Ordner-Dialog keine Möglichkeit, einen Ordner anzulegen –
also auch kein Projekt, wenn im Container noch kein passender Ordner existiert.

**Fix:**

- `IProjectService.createDirectory({ hostId?, path, name })` (eine Ebene,
  `EEXIST` → `project.directory-exists`, keine Pfad-Separatoren/`..`)
- Implementierung in `createProjectService` (+ Weiterleitung in
  `bindRemoteProjectIdentities`, Read-only-Fehler im Legacy-Service)
- „New folder“-Button + Inline-Formular in `DirectoryBrowser`, verdrahtet über
  `useProjectDirectoryServices` (Projekt-Editor, Remote-Folder-Auswahl) und
  `Root.tsx`
- i18n: `en-US`, `zh-CN` (`directoryBrowser.newFolder*`)

Der Dialog springt nach dem Anlegen direkt in den neuen Ordner, damit „Choose
folder“ keine zweite Suche braucht. Ein doppelter Name wird abgelehnt statt
still wiederverwendet.

## Patch erneuern (neue ZCODE_VERSION)

```bash
git clone --depth 1 --branch v<NEUE_VERSION> https://github.com/zai-org/ZCode.git /tmp/zcode-upstream
cd /tmp/zcode-upstream
for p in /pfad/zu/ZCodeAI-Server/patches/*.patch; do git apply "$p"; done   # Konflikte hier lösen
# Änderungen anpassen, dann:
git diff -- <betroffene Pfade> > /pfad/zu/ZCodeAI-Server/patches/000X-....patch
```

Der Installer prüft nach dem Anwenden Marker-Strings in den Zieldateien und
bricht bei einem nicht passenden Patch mit Exit 11 ab – statt eine halb
gepatchte, kaputte UI auszuliefern.
