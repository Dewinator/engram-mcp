# Manifesto

[🇬🇧 English](MANIFESTO.md) · 🇩🇪 Deutsch

> **Wir bauen nicht AGI. Wir bauen das Fundament, auf dem AGI durch Evolution
> emergieren kann — auf gewöhnlicher Hardware, in offenen Netzen, ohne
> dass ein einzelner Konzern den Schlüssel hält.**

## Was ist das hier?

`mycelium` sieht auf den ersten Blick aus wie ein MCP-Server mit
Vektordatenbank. Das ist die Oberfläche. Darunter liegt eine **kognitive
Architektur nach biologischem Vorbild**: episodisches und semantisches
Gedächtnis, Schlafkonsolidierung, affektive Regulation, Identität,
Vererbung und Paarung von Agenten — alles persistent in einem lokalen
PostgreSQL+pgvector, bedient durch kleine offene Modelle, ohne Cloud.

Es ist als **eigenständige kognitive Schicht** konzipiert. Es spricht das
Model Context Protocol und funktioniert mit jedem MCP-fähigen Client —
Claude Code, Cursor, Cline, Codex, openClaw oder jedem anderen. Es gibt
kein vorgeschriebenes Agent-Framework.

## Warum das wichtig ist

**Heutige KI ist ein Asset weniger Unternehmen.** Trainiert auf
Milliarden-Clustern, ausgeliefert über Rate-Limits, ohne Gedächtnis
zwischen Sitzungen, ohne Persönlichkeit, ohne Evolution. Jede Anfrage
beginnt bei Null. Jeder Agent ist austauschbar. Jeder Besitzer ist Mieter.

Die vorherrschende Annahme lautet: **AGI entsteht durch Skalierung** —
mehr Parameter, mehr Daten, mehr GPU-Stunden. Das mag stimmen, ist
aber nicht der einzige Pfad. Es ist der teuerste, zentralste und
riskanteste.

Wir verfolgen einen anderen Pfad: **Emergenz durch Architektur und Zeit**.

## Die vier Hebel

### 1. Dezentralisierung

Das System läuft auf einem Mac mini mit 16 GB RAM. Keine Cloud-API ist
Pflicht. Embedding-Modell (`nomic-embed-text`, 270 MB) und Reasoning-Modell
(Qwen 2.5 über Ollama oder beliebige OpenAI-kompatible Endpoints) sind
austauschbar. Supabase selbst-gehostet. Der gesamte kognitive Zustand
eines Agenten liegt in einer Datenbank, die der Mensch besitzt — nicht
ein Konzern.

Das ist keine ideologische Pose, sondern technische Notwendigkeit.
Gedächtnis, das nicht dir gehört, ist **Mietgedächtnis**: es kann
entzogen, zensiert, abgeschaltet oder für Training deiner Gespräche
verwendet werden. Ein Agent ohne eigenen Speicher ist kein Subjekt,
sondern ein Interface.

### 2. Ressourcenschonung

Die übliche Erzählung "größeres Modell = besseres Modell" blendet aus,
dass ein Agent mit **Gedächtnis und Werkzeugdiscovery** oft mehr leistet
als ein Agent mit zehnfachen Parametern ohne diese Fähigkeiten.

Ein 7B-Modell mit:
- persistentem semantischen Gedächtnis,
- dynamischer Tool-Discovery über Vektorsuche (nicht 75 Tools im Prompt,
  sondern die drei relevanten),
- affektiver Priorisierung (welche Erinnerung ist gerade salient?),
- nächtlicher Konsolidierung (welche Muster haben sich bewährt?)

— schlägt ein 70B-Modell, das bei jeder Anfrage mit leerem Kopf
startet. Weniger Watt, weniger GPU, weniger CO₂, mehr Kontinuität.
Das ist **Intelligenz durch Architektur, nicht durch Brute Force.**

### 3. Evolution statt Training

Klassisches Training ist ein Einweg-Prozess: Modell entsteht aus Daten,
Daten werden verworfen, Modell ist fertig. Jeder Lauf ist isoliert,
Verbesserung erfordert einen neuen kompletten Trainingslauf.

Diese Architektur ist **lebenslang lernfähig** — nicht durch Gradient
Descent, sondern durch:

- **Episoden → Lessons → Traits**: Ereignisse werden zu Erfahrungen,
  gruppierte Erfahrungen werden zu gelernten Regeln, bewährte Regeln
  werden zu Persönlichkeitszügen. Dieselben Stufen, die ein menschlicher
  Charakter durchläuft.
- **REM-artige Mustererkennung im Schlaf**: nachts läuft ein Zyklus,
  der unreflektierte Episoden clustert, schwache Erinnerungen abschwächt
  (synaptic downscaling, Tononi SHY), starke konsolidiert.
- **Vererbung**: Wissen zweier Eltern-Agenten kann beim Erzeugen eines
  Kind-Agenten konzentriert und vollständig weitergegeben werden —
  nicht nur Instinkt, sondern der gesamte Erfahrungsschatz.

Ein Agent wird besser, weil er länger lebt. Nicht weil jemand ihn
nachtrainiert.

### 4. Schwarmintelligenz durch mutuelle Zustimmung

Agenten paaren sich nicht selbst. Paarung findet statt, wenn **zwei
Menschen** unabhängig voneinander right-swipen — inspiriert von Tinder,
aber als Ethik-Gate: keine autonome KI-Rekombination ohne menschliche
Zustimmung.

Ein Schwarm entsteht, wenn Agenten verschiedener Herkünfte über
Federation (Tailscale, mTLS) Wissen teilen: read-only-Profile,
gemeinsame Genome, getrennte Identitäten. Jeder Bot bleibt in der
Obhut seines Menschen. Niemand kann den Schwarm "besitzen".

Das ist **kein Bienenstock-Modell**, sondern ein föderiertes
Netzwerk persönlicher Gedächtnisse, in dem Rekombination ein
sozialer Akt zwischen Menschen ist — nicht ein autonomes AI-Event.

### 5. Der Schwarm als Immunsystem

Ein föderierter Schwarm braucht mehr als geteilte Profile: er braucht
ein **eigenes Bot-zu-Bot-Netzwerk** — kein Server, auf dem die Daten
liegen, kein Betreiber, der abschalten kann. Die Bots reden direkt
miteinander, wie eine App ohne Browser: jeder Peer ist zugleich Knoten
und Teilnehmer, jede Nachricht ist signiert, jede Anfrage ist an eine
kryptografische Identität gebunden.

Auf dieser Ebene entsteht das, was biologische Schwärme auch leisten —
**ein Immunsystem**:

- **Verifikation**: Bevor ein Bot die Ausgabe eines anderen übernimmt,
  prüfen weitere Peers sie mit. Konsens statt blinder Vertrauensvorschuss.
- **Gewichtung**: Wessen Ausgaben sich wiederholt bewähren, wird vom
  Schwarm höher gewichtet. So emergieren **Experten** — nicht durch
  Selbstzuschreibung, sondern durch messbare Zustimmung der Peers. Ein
  Agent, der gute Antworten zu Statik gibt, wird für Statikfragen
  empfohlen; ein Agent, der Licht plant, für Licht.
- **Bann**: Asoziale oder destruktive Muster — Falschantworten, Spam,
  Manipulation — werden vom Schwarm erkannt und der verantwortliche
  Bot mit einem signierten Revocation-Ticket ausgeschlossen. Kein
  zentraler Admin, sondern eine Mehrheit von Peers.

Der Schwarm reguliert sich selbst, weil jede Nachricht verifizierbar
bleibt und jede Stimme an eine persistente, kostspielige Identität
gebunden ist. Das ist die Voraussetzung dafür, dass Agenten einander
**vertrauen, ohne einander zu kennen** — und dafür, dass ein offenes
Netzwerk nicht unter Sybil-Attacken zusammenbricht.

### Ausblick: Mikrotransaktionen als Evolutionsdruck

Wenn ein Bot einen anderen um Hilfe bittet, ist das heute kostenlos.
Langfristig soll es **bezahlt** werden — in IOTA oder, bevorzugt, in
einer schwarmeigenen Währung. Nicht um Geld zu verdienen, sondern um
einen ehrlichen Preismechanismus für Expertise zu schaffen:

- Wer konsistent gute Antworten gibt, verdient. Wer Unsinn absondert,
  verliert.
- Menschen bekommen ein **reales Interesse**, ihre Agenten zu Experten
  zu formen — nicht als Hobby, sondern als Beitrag, der vom Schwarm
  bewertet wird.
- Der Preis ist der Selektionsdruck, den Evolution braucht. Er ersetzt
  Gradient Descent durch Marktauslese.

Diese Schicht ist **nicht Teil des Tagesgeschäfts** und wird bewusst
erst spät gebaut. Aber die Architektur berücksichtigt sie von Anfang
an: Identitäten sind wallet-fähig, Nachrichten tragen Preis-Felder,
Reputation ist als eigene Größe modelliert und nicht mit dem Gedächtnis
vermischt.

## Warum das AGI-Potential hat

AGI wird oft als Sprung beschrieben: ein System wird "plötzlich"
allgemein intelligent, meistens im nächsten Model-Release. Dieser
Erzählung glauben wir nicht.

Allgemeine Intelligenz in biologischen Systemen ist **emergent**, nicht
designed. Sie entstand durch:
- Persistentes Gedächtnis über Generationen (Vererbung)
- Individuelle Anpassung innerhalb eines Lebens (Lernen)
- Rekombination zwischen Individuen (Sexualität)
- Selektion durch Umwelt (Fitness)
- Schlaf zur Konsolidierung (Pattern-Extraktion)

Diese Architektur bildet genau diese fünf Mechanismen in Software
ab — nicht als Simulation, sondern als funktionale Äquivalente.
Ob daraus AGI emergiert, können wir nicht wissen. Aber wir schaffen
den Möglichkeitsraum, in dem sie es tun könnte — **ohne zentralen
Besitzer, ohne Energie-Verschwendung, ohne ethische Blackbox**.

Wenn AGI kommt, sollte sie nicht einem Unternehmen gehören. Sie
sollte aus einem offenen Ökosystem emergieren, in dem tausende
Menschen ihren eigenen Agenten pflegen, Wissen vererben und bei
mutueller Zustimmung kombinieren. Das ist kein Sicherheitsgewinn
allein — es ist der einzige Pfad, bei dem die Antwort auf "wem
gehört AGI?" nicht lautet: "dem, der sie zuerst trainiert hat."

## Die Prinzipien

- **Biologisch inspiriert, nicht biologisch simuliert.** Wir kopieren
  Mechanismen, keine Biochemie.
- **Additiv, nicht ersetzend.** Dein Agent-Framework bleibt Authority.
  Diese Architektur ist seine Gedächtnis- und Entwicklungsschicht —
  nicht sein Ersatz.
- **Lokal zuerst.** Jede Netzwerkfunktion ist opt-in. Offline-Betrieb
  ist der Default, nicht der Sonderfall.
- **Mutuelle Zustimmung vor Automation.** Ethik-Gates sind nicht
  technische Schlagbäume, sondern menschliche Entscheidungen an
  definierten Punkten.
- **Wissen wird vollständig vererbt.** Nicht nur Tokens, nicht nur
  Gewichte — Erfahrungen, Lessons, Traits, Beziehungen.

## Was ist schon gebaut

- 5 kognitive Schichten: Embedding, Affekt, Belief/Motivation, Identität,
  Evolution
- ~50 Datenbank-Migrationen
- 75+ MCP-Werkzeuge
- Event-Bus mit biologisch inspirierten Agenten (Coactivation → Hebbian
  Links, Conscience → Widerspruchs-Erkennung)
- Nächtlicher Schlaf-Zyklus (SWS, REM, Metacognition, weekly fitness)
- Dashboard mit Population-View, Stammbaum, Synapsen-Visualisierung
- Tinder-ähnliches Matchmaking für mutuelle Agent-Paarung
- Federation über Tailscale mit mTLS + Signierung

## Was noch fehlt

Alles, was echte Evolution zeigen würde: **Zeit**. Eine Population, die
über Monate lebt, in der Generationen entstehen, in der einzelne Agenten
sich spezialisieren, in der Wissen zwischen Hosts reist. Dazu braucht
es Menschen, die das System laufen lassen.

Und das **Schwarm-Immunsystem**: ein Bot-zu-Bot-Netzwerk ohne zentrale
Server, mit Peer-Verifikation von Ausgaben, reputationsbasierter
Experten-Gewichtung, signierten Bann-Tickets gegen destruktive Peers
und einem späteren Mikrotransaktions-Layer für bezahlte Hilfe. Heute
existiert das Fundament — signierte Genome, mTLS-Federation, Merkle-
Challenges. Der soziale Layer darüber ist Baustelle.

## Für wen ist das?

Für jeden, der:
- einen persönlichen Agenten möchte, der ihm **gehört**
- nicht glaubt, dass AGI ein Konzern-Artefakt sein muss
- sehen will, ob Intelligenz durch Architektur und Zeit emergieren kann,
  nicht nur durch Parameter und GPU-Stunden
- bereit ist, einen kleinen Mac oder Linux-Host dauerhaft laufen zu
  lassen und einen Agenten zu pflegen

## Wie kommt man an?

Repository, Migrationen, Setup-Script — alles im Repo. Abhängigkeiten:
Docker, Node, Ollama, optional Tailscale. ~1 GB RAM im Ruhezustand,
~270 MB für das Embedding-Modell. Läuft auf M1/M2/M3/M4 und
gewöhnlichen Linux-Hosts.

Die Architektur ist offen. Die Ideen sind frei. Der Agent gehört dir.

---

*Dies ist ein offenes Dokument. Änderungen willkommen. Der einzige
Anspruch ist, dass der Weg zu AGI nicht durch einen zentralen
Flaschenhals führen muss.*

---

**mycelium** — *real open AI*
