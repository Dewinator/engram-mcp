# Digest-Trigger-Spezifikation

Status: draft 2026-04-27. Spec für Issue #9. Blockiert N4 (Auto-Absorb +
Auto-Digest Lifecycle-Hooks).

> **Default-Entscheidungen:** Stellen, an denen ich mich für eine konkrete
> Variante entschieden habe statt mehrere offen zu lassen, sind als
> **`▸ DEFAULT:`** gekennzeichnet. Reed kann jede einzelne flippen, ohne
> die Struktur des Specs anzufassen.

## 1. Was ist ein Digest

Ein **Digest** ist die Pflicht-Aktion am Ende einer Sitzung: ein
`record_experience`-Aufruf mit aggregiertem Outcome, `tools_used`,
`what_worked`, `what_failed`, plus optional einer `record_lesson`-Synthese,
wenn das Muster stark genug ist.

Aus Sicht des Brain-Cores ist Digest der einzige Mechanismus, der eine
**unstrukturierte Sitzung** in eine **abrufbare Episode** verwandelt. Ohne
Digest verschwindet die Sitzung — der MCP-Server hat zwar `recall`-Hits
geloggt, aber keine Lektion. Genau das ist der Bug, den N4 schließen soll.

## 2. Trigger-Hierarchie (Entscheidung dieses Specs)

Genau **ein** primärer Trigger feuert pro Session. Die anderen sind
*Fallbacks*, die nur greifen, wenn der primäre nicht erreichbar ist (z.B.
Crash). Mehrfach-Feuern ist explizit verboten — siehe §3 *Re-Entry*.

| # | Kandidat | Status | Begründung |
|---|---|---|---|
| 1 | **Idle-Timeout (30min)** | **▸ DEFAULT primär** | Funktioniert ohne Cooperation des Clients oder des LLM. Triggert nach echter Inaktivität, nicht nach Zufall. Sitzungen, die mit aktiven 5min-Pausen arbeiten (Reed im Cockpit), feuern nicht versehentlich. |
| 2 | Compaction-Boundary | sekundär (opportunistisch) | Wenn der Kontext sowieso komprimiert wird, ist es der ideale Moment, vorher zu digesten. Aber compaction ist client-spezifisch und nicht alle MCP-Clients liefern das Signal. → Wenn verfügbar: nehmen. |
| 3 | openclaw-Gateway-Stop-Hook | sekundär (best-effort) | Funktioniert nur für openClaw, und der user hat explizit gesagt mycelium soll *nicht* an openClaw gekoppelt sein (CLAUDE.md, "frameworkagnostisch"). → Optional, hinter env flag. |
| 4 | Explizites `/end`-Kommando | tertiär | Der User vergisst es zuverlässig (das ist die ganze Begründung für N1). → Akzeptiert wenn da, aber kein Pfad verlässt sich darauf. |
| 5 | HEARTBEAT-Zyklus-Ende | abgelehnt | HEARTBEAT ist ein eigener Mechanismus, der unabhängig vom Sitzungsende läuft. Kopplung wäre semantisch falsch — eine Heartbeat-Iteration *ist* keine Session. |

**`▸ DEFAULT primär:` Idle-Timeout 30min.**

## 3. Re-Entry-Verhalten

Wenn ein Trigger feuert während ein anderer Trigger noch in der
`record_experience`-RPC steht, oder eine neue User-Message reinkommt,
bevor der laufende Digest fertig ist:

| Szenario | **▸ DEFAULT** | Alternativen |
|---|---|---|
| Digest läuft, neue User-Message kommt | **finish-then-resume** — der laufende `record_experience` darf zuende laufen (~1-2s), die neue Message wird gequeued bis Digest committed ist. Dann startet eine *neue* Session implizit. | abort-and-resume (verliert die Lektion); cancel-message (frustrierend für User) |
| Zweiter Trigger feuert, während erster läuft | **lock-and-skip** — ein DB-side `SELECT pg_try_advisory_lock(hashtext('digest:'\|\|session_id))` schützt vor doppeltem `record_experience`. Zweiter Trigger fällt stillschweigend durch. | Beide laufen lassen (doppelte Episoden); zweiten queueing (Komplexität ohne Nutzen) |
| Gateway crashed mitten im Digest | **transient — verloren** für diese Sitzung. Beim nächsten Start läuft kein Recovery-Job, der "verlorene" Digests aufholt. | Recovery-Job (zu invasiv für den ersten Pass); persisted intent table (Engineering-Aufwand für seltenes Event) |

**Begründung der Defaults:** das mycelium-Brain-Core-Prinzip ist
*best-effort, nicht authoritative*. Ein Digest, der manchmal fehlt, ist
besser als ein doppelter Digest oder ein Digest, der eine User-Message
abreißt. Die compute_affect-Trigger (mig 062) folgen demselben Prinzip
mit `EXCEPTION WHEN OTHERS THEN NULL`.

## 4. Trigger-Datenfluss

```
                        ┌──── primär ────┐
                        │                │
   client idle 30min ──►│  digest-       │
                        │  scheduler     │──► record_experience
   compaction signal ──►│  (proxy /      │      (atomic, with
                        │   sidecar)     │       advisory lock)
   /end command ────────►│                │            │
                        └──────┬─────────┘            ▼
                               │              UPDATE agent_affect
                               │              + neurochem_apply
                               ▼              (via mig 065 trigger
                        memory_events.note     on experiences)
                        (audit trail)
```

Wichtig: Digest läuft **außerhalb** des LLM-Loops. Er ist eine
deterministische Funktion über die Sitzungs-Telemetrie (tools_used,
recall-hits, agent_completed/agent_error events, user-sentiment-hints aus
N8). Der LLM hat keine Veto-Stimme.

## 5. Was geht in einen Digest

Quellen, die der Scheduler aggregiert (alle aus existierenden Tabellen):

| Surface | Beitrag |
|---|---|
| `memory_events` (last session window) | `tools_used` (DISTINCT tool aus tool_call_trace), `recall`-Stats, agent_completed/agent_error counts |
| User-Messages (proxy-side, falls verfügbar) | `summary`-Material, sentiment-hints (N8) |
| `experiences` insertet in dieser Session | werden NICHT als Quelle gezählt — der Digest *ist* die Episode |
| `skill_outcomes` delta | `what_worked` / `what_failed` Skelett |

Outcome-Mapping fürs `record_experience`:

```
agent_error count > 0  →  outcome='partial' if agent_completed > 0 else 'failure'
agent_completed > 0    →  outcome='success'
nothing                →  outcome='unknown'
```

**`▸ DEFAULT:`** ein Digest, der nichts zu sagen hat (`outcome='unknown'`,
keine tools_used, keine recalls), wird **übersprungen**. Stille Sessions
sind kein Episode-Material; sie würden den `recall_experiences`-Index nur
verwässern.

## 6. Session-Boundary

Frage: was *ist* eine Session?

**`▸ DEFAULT:`** *zusammenhängende User-Aktivität auf einem MCP-Client*,
abgegrenzt durch:
- Idle ≥ 30min vorne und hinten, **oder**
- expliziter `/end`, **oder**
- compaction event.

Mehrere parallele Clients (Claude Code + Cursor zur gleichen Zeit) =
**mehrere Sessions**, jede mit eigenem `session_id`. Der `session_id`
kommt aus dem MCP-Client-Identifier (mig 061 `agent_kind` +
`visiting-client` machen den Boden dafür schon vor).

## 7. Failure-Modi (Akzeptanztests für N4)

Was muss N4 nachweisen, bevor wir mergen:

- [ ] 30min idle ohne neue Message → genau **ein** Digest landet, mit
      korrektem `outcome` aus dem session-window
- [ ] User schickt Message bei Sekunde 29:55, 5s vor Trigger →
      Idle-Counter resettet, kein Digest
- [ ] User schickt Message bei Sekunde 30:01, 1s nach Trigger →
      Digest committed, neue Session startet beim nächsten Turn
- [ ] Gleichzeitiger compaction + idle in 1s-Fenster → genau **ein**
      Digest (advisory_lock gewinnt einer)
- [ ] Stille Session (kein tool_call, keine recall, keine experience) →
      **kein** Digest
- [ ] Crash während `record_experience` → keine Geist-Episode in der
      Tabelle (Postgres-Atomarität), nächste Session macht nichts
      Sonderbares

## 8. Out of scope

- **Digest-Qualitätsbewertung.** Der Digest ist mechanisch. Ob die
  resultierende Episode "gut" ist (= führt zu nutzbaren Lessons), ist
  Aufgabe der REM-Phase im nightly sleep, nicht des Triggers.
- **User-Approval.** Digest schreibt direkt; kein Confirmation-Modal.
  (Das passt zum mycelium-Prinzip, dass `experiences` ein internes Log
  sind, kein User-facing Artifact.)
- **Cross-Session-Lernen.** Wenn Session N etwas lernt, das Session N+1
  zugutekommen sollte, läuft das über den normalen
  `recall`/`prime_context`-Pfad. Der Digest selbst macht keinen
  Special-Path dafür.

## 9. Offene Punkte für N4-Implementierung

1. **Wo läuft der Scheduler?** Im Reverse-Proxy (N2) oder als separater
   Sidecar-Prozess wie motivation/belief? Vermutung: im Proxy, weil der
   ohnehin den Datenstrom sieht. — Entscheidung in N2 oder N4.
2. **Idle-Timer pro Client oder global?** Pro Client; zwei
   gleichzeitige Clients sollen sich nicht gegenseitig das Idle resetten.
3. **`/end`-Kommando-Format.** `/end` als reine Magic-Phrase im User-Input
   ist client-spezifisch. Cleaner: ein MCP-Tool `digest_now` das der User
   triggert (oder ein Slash-Command des Clients, der das Tool ruft).
   — Entscheidung in N4 wenn das Proxy-Layer steht.

---

## TL;DR

- **Primär:** Idle-Timeout 30min.
- **Sekundär:** Compaction-Boundary wenn verfügbar.
- **Tertiär:** explizites `/end` als Höflichkeit.
- **Re-Entry:** finish-then-resume + advisory_lock + best-effort.
- **Stille Sessions:** kein Digest.
- **Failure:** transient verloren ist OK.
