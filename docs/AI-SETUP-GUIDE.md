# Setting up the AI features

Pen Island has two separate AI features, and they're set up separately.

| Feature | What it does | Who answers |
| --- | --- | --- |
| **Agent panel** | The chat beside every mode: Ask, Review, Draw it, Reveal. | The model in **Settings → AI**. |
| **ChatBot footnotes** | Select text in Annotate, choose **Ask ChatBot**, and an explanation arrives as a footnote. | An assistant app the PC starts automatically (the default), your AI model, or an AI assistant bot you message. |

Setting up one doesn't set up the other. Part 1 covers the Agent panel. Parts 2
and 3 cover ChatBot. Part 4 covers keeping the tablet connected to the PC, at
home and away.

---

## Part 1: Agent panel with a local model

The Agent panel talks to any OpenAI-compatible server. Run one on your PC, then
point the app at it.

### 1. Start a model server

Pick one:

| Server | Start it | URL for the app |
| --- | --- | --- |
| [Ollama](https://ollama.com) | `ollama pull <model>`, then leave Ollama running | `http://localhost:11434/v1` |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | `llama-server -m <model>.gguf --port 8000` | `http://localhost:8000/v1` |
| [LM Studio](https://lmstudio.ai) | Load a model, then turn on the local server under **Developer** | `http://localhost:1234/v1` |

### 2. Point the app at it

Open **Settings → AI**.

1. Set **Provider** to **Local** (llama.cpp, LM Studio, vLLM) or **Ollama**.
2. On that provider's tab, enter the **Server address** from the table and pick
   the **Chat model**.
3. If the model can read images, turn on **Can read images**. The agent reads your
   board as a picture, so a vision model gives much better answers. You can also
   name a separate **Image model (optional)**.
4. Save. **Status** at the top of the section should read
   *AI model online*.

**Model for each task** lets you send each kind of request (Review and Ask,
Reveal, Diagrams, Planner) to a different provider, for example **Planner** to a
larger cloud model. Leave them all on the default until the basics work.
(**Background check** is listed too, but that feature is turned off.)

A mode can also use one of two assistants instead of a model:

- **Assistant app**: Codex or Claude Code on the PC, the same app ChatBot uses
  (see [An assistant app on this PC](#an-assistant-app-on-this-pc-codex-claude-code)).
- **AI assistant**: an assistant connected over MCP with `lc mcp`, as in
  [Option B](#option-b-an-assistant-bot-over-mcp). It answers when it checks for
  requests, so set **AI assistant time limit** to how long a run should wait.
  **Send the board image to the AI assistant** controls whether it sees the
  board as a picture.

Both run on the PC through the desktop app, even when you ask from the tablet.

### Using it from the tablet

`localhost` in Settings means the device the app runs on. On the tablet, that's
the tablet. To use a model on your PC from the tablet:

- In the tablet's Settings, use the PC's network address, for example
  `http://192.168.1.20:11434/v1`.
- Make the server listen on the network, not just on the PC itself. For Ollama,
  set `OLLAMA_HOST=0.0.0.0` before starting it. For llama.cpp, add
  `--host 0.0.0.0`. For LM Studio, turn on **Serve on Local Network**.
- Allow the port through Windows Firewall if the tablet can't connect.

This only works on your home network. To use it away from home, see
[Part 4](#part-4-reaching-the-pc-from-other-devices).

---

## Part 2: ChatBot footnotes with a local model

ChatBot always needs the **desktop app running on the PC**. The PC holds the
footnote inbox, delivers the answer to the device that asked, and sync carries
it to your other devices. Ask ChatBot works from the tablet too, as long as the
tablet is paired with the PC's hub.

Open **Settings → AI → ChatBot** and choose who answers under **Footnotes
written by**. **An assistant app on this PC** is the default for new installs;
a choice you saved earlier is kept.

### Option A: Your AI model (simplest)

Set **Footnotes written by** to **Your AI model**. The PC answers every single
footnote request on its own, using the **Provider** from Part 1. Nothing else to
set up. Page runs need one of the assistant modes.

**Tested October 13, 2026:** an actual tablet scratch request reached the PC
over Tailscale and received a local Qwen answer. The answer saved, its spinner
cleared, and the tablet acknowledged it.

- The model runs from the PC, so `localhost` here means the PC, even when you
  asked from the tablet.
- The model only sees the document text around your selection. It can't search
  the web, and it only keeps links that appear in the document.
- If the model server is off or takes longer than three minutes, the footnote
  says the answer failed.

### Option B: An assistant bot over MCP

Use this when you want an assistant app on your PC to answer instead, for
example LM Studio with a tool-calling model, Codex, Cursor or Claude Code.
Unlike Option A, the assistant can use its own tools, such as web search, before
it answers.

1. Set **Footnotes written by** to **An AI assistant bot**, and pick your
   assistant under **AI assistant** (OpenAI Dots, Meta Muse AI, xAI Grok Bot,
   Codex or Cursor, or Other MCP AI assistant).
2. Build the `lc` command-line tool from the repo root. Older builds of `lc`
   don't have the `mcp` command.

   ```bash
   cargo install --path .
   ```

   This puts `lc.exe` in `%USERPROFILE%\.cargo\bin`.
3. Add it to your assistant as a **local (stdio) MCP server**: the command is the
   full path to `lc.exe`, and the only argument is `mcp`. Most apps take an
   `mcp.json` like this (in LM Studio: **Program → Install → Edit mcp.json**):

   ```json
   {
     "mcpServers": {
       "pen-island": {
         "command": "C:\\Users\\<you>\\.cargo\\bin\\lc.exe",
         "args": ["mcp"]
       }
     }
   }
   ```

   `lc mcp` finds the hub and its token from your config on its own. If you moved
   the hub off port `7878`, add `"--hub", "http://127.0.0.1:<port>"` to `args`.
4. Check the assistant lists the footnote tools `list_footnote_requests`,
   `get_footnote_request` and `submit_footnote`, and the page-run tools
   `list_annotation_jobs`, `get_annotation_pages`, `get_annotation_reference`,
   `submit_page_annotations` and `finish_annotation_job`. With **Let it hand the
   writing to an app on this PC** on, it also gets `start_assistant_app` and
   `assistant_app_status`. Agent-panel runs add their own coach tools while a
   mode is set to **AI assistant**.

**The assistant doesn't answer on its own.** Connecting it gives it the tools
and tells it how the inbox works, but it only acts when asked. Pen Island also
offers two ready-made prompts. Assistants that support MCP prompts show them in
a prompt or slash-command list:

- **Answer my footnote requests**: answers everything waiting, once.
- **Keep answering footnote requests**: answers now, then keeps checking every
  few minutes, if the assistant can run scheduled tasks. It says so if it can't.

Otherwise, just say: "Answer my pending footnote requests."

In LM Studio, pick a model that supports tool calls; the model list marks them.

---

### An assistant app on this PC (Codex, Claude Code)

An AI assistant bot answers when you message it (or when its chat supports a
recurring task). An assistant app is started automatically by Pen Island on
your PC when you ask for a footnote or start a page run.

| Footnotes written by | Connection | Who starts the answer |
| --- | --- | --- |
| **Your AI model** | The PC's local server or cloud API key. | Pen Island calls the model for a single footnote. |
| **An AI assistant bot** | Your existing MCP connection; remote bots use the bridge and sign-in. | You ask the bot, or schedule its chat. |
| **An assistant app on this PC** | Local Pen Island tools only. No public tunnel is needed. | Pen Island starts Codex or Claude Code on the PC automatically. |

Open **Settings → AI → ChatBot**, choose **An assistant app on this PC**,
pick the **App** (Codex or Claude Code), optionally enter its **Model**, choose
the **Effort** (Light, Normal or Thorough), and press **Test**. Test only
checks the connection; it won't answer any requests. These app settings are
saved on the PC, including when you change them from a paired tablet.

The app runs headless in an empty folder with only Pen Island's MCP tools: no
shell, no web search, no other tools. Sign in to the chosen CLI beforehand;
this uses its subscription limits rather than an API key.

- **Codex** signs in with ChatGPT. Pen Island locks Codex down per release, so
  it only runs versions it has checked: 0.162.1 and 0.163.0 today
  (`VERIFIED_CODEX_VERSIONS` in `src/serve/agent_cli.rs`). After a Codex
  update, press **Test**. A newer version is refused until it has passed a Test
  and a page run and been added to that list.
- **Claude Code** needs a claude.ai sign-in. It refuses an API key in this
  mode, so an `ANTHROPIC_API_KEY` doesn't help. If Test says to sign in, run
  `claude` on the PC once and sign in.

Codex and Claude Code each passed Test, one footnote and a two-page run on
November 9, 2026.

Leave the desktop app running. Single footnotes and page runs start locally,
one assistant process at a time, in a queue. Pending app work resumes after the PC app
restarts. Progress appears in ChatBot History and pending footnotes; if it
fails, open ChatBot settings and press **Test**. If you had chosen **An AI
assistant bot** before, that choice is kept and keeps waiting for your
assistant.

**Your AI model** answers single footnotes only. For page runs, choose an
assistant mode. Use **Attach** for library files or PDF page ranges; the
assistant infers whether they contain notes, problems or solved homework.
It points at relevant problems without solving them.

With **An AI assistant bot**, the switch **Let it hand the writing to an app
on this PC** lets you tell the bot to "use Codex" (or Claude Code): the bot
calls `start_assistant_app`, and the assistant app writes the footnotes on the
PC while the bot checks `assistant_app_status`.

---

## Part 3: ChatBot footnotes with Grok Bot

Grok Bot runs in xAI's cloud. It can't start `lc.exe` on your PC or reach
`localhost`, and a personal Grok Bot only connects to custom servers by
**OAuth sign-in**; it never sends a pasted token. So the PC runs two small
servers behind a public ngrok address:

```text
Grok Bot ──https──► ngrok ──► OAuth bridge (127.0.0.1:7880) ──► lc mcp (127.0.0.1:7879) ──► Pen Island hub
         (signs in with your GitHub account)      (adds the private token)
```

- **`lc mcp --listen`** serves the three footnote tools and requires a private
  token. It is never exposed directly.
- **The OAuth bridge** (`scripts/chatbot-oauth-bridge/bridge.py`) handles Grok's
  sign-in through GitHub. It only accepts **your** GitHub account, then calls
  `lc mcp` with the private token. Grok never sees that token.

**Status, October 13, 2026:** Grok Bot connected through this route and lists
the footnote tools. A full footnote answer from Grok hasn't been tested yet.

You need the `lc` tool from Part 2 (step 2), Python 3, and **Footnotes written
by** set to **An AI assistant bot**, with **xAI Grok Bot** picked under **AI
assistant**, on the device you'll ask from.

### 1. Make the private token

`lc mcp --listen` won't start without a token file. Use a new random value, not
the hub's six-digit pairing code: 32 to 256 letters, digits, `-` or `_`.

The bridge only reads files inside the project folder. Keep everything for this
setup in `.local/chatbot/`, which git ignores. Don't use `.tmp-*` names: those
are scratch files and get cleaned up. In Git Bash, from the repo root:

```bash
mkdir -p .local/chatbot && openssl rand -hex 32 > .local/chatbot/mcp-token.txt
```

Never paste it into a chat.

### 2. Start `lc mcp` in HTTP mode

With the desktop app running:

```bash
lc mcp --listen 127.0.0.1:7879 --auth-token-file .local/chatbot/mcp-token.txt
```

It prints `ChatBot MCP: http://127.0.0.1:7879/mcp` and listens only on the PC.

### 3. Set up ngrok and note your address

1. Install it and register your account's authtoken (from the ngrok dashboard):

   ```bash
   winget install ngrok -s msstore
   ```

   ```bash
   ngrok config add-authtoken <your-ngrok-authtoken>
   ```

2. Your free account has one **Dev Domain**, a stable address ngrok assigns,
   made of three random words, such as `word-word-word.ngrok-free.dev`. You can't pick its name on
   the free plan. It's shown in the dashboard and when the tunnel starts. The
   rest of this guide calls it `your-domain.ngrok-free.dev`.

### 4. Register a GitHub OAuth app

On GitHub: **Settings → Developer settings → OAuth Apps → New OAuth App**.

| Field | Value |
| --- | --- |
| Application name | `Pen Island ChatBot` |
| Homepage URL | `https://your-domain.ngrok-free.dev` |
| Authorization callback URL | `https://your-domain.ngrok-free.dev/auth/callback` |

Leave **Enable Device Flow** unticked. Register it, then **Generate a new
client secret**. Keep the Client ID and secret for step 5, and don't paste them
into a chat.

### 5. Set up the bridge

1. Create a Python environment and install the pinned packages, from the repo root:

   ```bash
   python -m venv .local/chatbot/venv
   ```

   ```bash
   .local/chatbot/venv/Scripts/python -m pip install -r scripts/chatbot-oauth-bridge/requirements.txt
   ```

2. Make a key for the bridge's encrypted sign-in storage:

   ```bash
   mkdir -p .local/chatbot/oauth-state && .local/chatbot/venv/Scripts/python -c "import base64,os;print(base64.urlsafe_b64encode(os.urandom(32)).decode())" > .local/chatbot/oauth-state/storage.key
   ```

3. Find your numeric GitHub account ID. This is the only account the bridge
   will let in:

   ```bash
   gh api user --jq .id
   ```

   Without the GitHub CLI, open `https://api.github.com/users/<your-username>`
   and use `"id"`.

4. Save the settings as `.local/chatbot/config.json`. That's the file the
   bridge reads by default, and git ignores it. Exactly these fields:

   ```json
   {
     "public_base_url": "https://your-domain.ngrok-free.dev",
     "github_owner_id": 12345678,
     "github_client_id": "<Client ID>",
     "github_client_secret": "<client secret>",
     "backend_token_file": ".local/chatbot/mcp-token.txt",
     "state_dir": ".local/chatbot/oauth-state",
     "storage_key_file": ".local/chatbot/oauth-state/storage.key"
   }
   ```

5. Start it:

   ```bash
   .local/chatbot/venv/Scripts/python scripts/chatbot-oauth-bridge/bridge.py
   ```

   It prints `Starting authenticated ChatBot OAuth bridge on 127.0.0.1:7880.`
   It never prints the secret, the token or sign-in codes.

### 6. Point ngrok at the bridge

```bash
ngrok http 7880 --url https://your-domain.ngrok-free.dev
```

This uses your Dev Domain. Point it at **7880** (the bridge), never at 7879.

### 7. Check it from outside

The sign-in discovery address should answer `200`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://your-domain.ngrok-free.dev/.well-known/oauth-authorization-server
```

A tool call without signing in should get `401`, even with your private
`lc mcp` token, because only GitHub sign-ins are accepted from outside:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://your-domain.ngrok-free.dev/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### 8. Connect Grok Bot

1. In a Grok Bot chat, ask it to add a custom remote MCP server named
   `Pen Island` at `https://your-domain.ngrok-free.dev/mcp`. If you added one
   before that failed, ask it to remove that one first; it keeps old errors.
2. Connect it. Grok sends you to **GitHub** to sign in, then to the bridge's
   **consent page**. Check that it names Grok's app, then approve.
3. Grok should report that Pen Island is connected, with tools for single
   footnotes and for annotating page ranges.

Grok only answers when asked. Pick **Keep answering footnote requests** from its
prompt list if it shows one, or say "answer my pending footnote requests and keep
checking every few minutes." That's the one-time setup.

Grok reads the list of tools when you connect. After the app is updated with new
ChatBot abilities, remove Pen Island in Grok and add it again; you don't have to
explain anything to it again.

### Annotating a chapter

1. Open the PDF and tap the ChatBot icon in the right-hand tray. The sheet walks
   four steps: **Request**, **Reading**, **Attach** and **Review**.
2. **Request**: choose the page range (up to 40 pages), an optional focus, and
   how many footnotes a page gets.
3. **Reading**: say what kind of document it is and which fields each footnote
   fills. ChatBot writes for the kind of text: a story gets a reading
   companion, a textbook a study guide.
4. **Attach** (optional): add pages of this PDF, such as the chapter's
   problems, or homework and notes files from your library. ChatBot then aims
   the footnotes at what those problems need, without solving them.
5. **Review** recaps the request. Tap **Start**. An assistant app starts on its
   own; with Grok, ask it to "answer my annotation jobs." Footnotes appear as it
   works. Keep the document open on that device.

Each run is listed under **History** in the sheet. **Cancel** stops one that's
still going, and **Undo** removes every footnote it added and nothing else.

Grok uses whichever model you've chosen in the Grok app. Pen Island can't pick
the model or how hard it thinks. With an assistant app, **Model** and
**Effort** in ChatBot settings choose them.

### Startup procedure (each time you use ChatBot)

What you need running depends on how ChatBot answers (**Settings → AI →
ChatBot**):

| Answer mode | Needs running on the PC |
| --- | --- |
| Your AI model | The desktop app and your model server |
| An assistant app on this PC (Codex, Claude Code) | The desktop app. Codex (a checked version) or Claude Code installed and signed in |
| An AI assistant bot on the PC (Codex, Cursor, LM Studio) | The desktop app and the assistant, with `lc mcp` added as a local server |
| An AI assistant bot in the cloud (Grok Bot) | All four steps below |

For Grok Bot, start these in order, each in its own terminal from the project
folder, and leave them open:

1. **The desktop app.** It is the hub everything talks to (port 7878).
2. **`lc mcp`**, the footnote tools:
   ```bash
   lc mcp --listen 127.0.0.1:7879 --auth-token-file .local/chatbot/mcp-token.txt
   ```
3. **The bridge**, Grok's sign-in door:
   ```bash
   .local/chatbot/venv/Scripts/python scripts/chatbot-oauth-bridge/bridge.py
   ```
4. **ngrok**, the public address (your reserved domain from step 3):
   ```bash
   ngrok http 7880 --url https://your-domain.ngrok-free.dev
   ```

Check it: `http://127.0.0.1:7880/mcp` should answer `401` (sign-in needed),
and the ngrok window should show your address. Then ask Grok to answer your
footnote requests.

After updating the app, restart `lc mcp` and the bridge too, then remove
and re-add Pen Island in Grok so it sees any new tools.

The tablet only needs the desktop app reachable (same Wi-Fi, or Tailscale);
it doesn't need ngrok. adb over Wi-Fi is only for installing new builds.

When you're done, stop ngrok first: nothing reaches your PC while it's off.

If you already use Tailscale, its Funnel feature can replace ngrok: point it at
port 7880 and use the Funnel address in steps 4 and 5. See
[Part 4](#tailscale-funnel-instead-of-ngrok).

---

## Part 4: Reaching the PC from other devices

The tablet finds the PC by its address on your network, something like
`192.168.1.20`. The desktop app's **Pad hub** listens on port `7878` there.

### Keep the PC's address from changing

Your router hands out these addresses and can give the PC a different one after
a restart. The tablet then can't find the hub until you update the address. A
**DHCP reservation** tells the router to always give the PC the same one.

1. Find the PC's MAC address and current address: run `ipconfig /all` and look
   under the adapter you use (Ethernet or Wi-Fi) for **Physical Address** and
   **IPv4 Address**. **Default Gateway** is the router's address.
2. Open the router's address in a browser and log in. The admin password is
   often on a sticker on the router.
3. Find the reservation page. Depending on the brand, it's called **DHCP
   Reservation**, **Address Reservation**, **Static Lease** or **Reserved IP**,
   usually under **LAN** or **DHCP**. Many routers also let you pick the PC from
   the list of connected devices and choose **Reserve**.
4. Add the PC's MAC address with its current IPv4 address, and save.

Wired and Wi-Fi connections have different MAC addresses. If the PC uses both,
reserve both.

### Tailscale: use it away from home

[Tailscale](https://tailscale.com) puts your devices on a private network of
their own. Each one gets a fixed `100.x.x.x` address and a name that work from
anywhere with internet. Only devices signed in to your account can connect, and
nothing is opened to the public internet. The free Personal plan covers this
(non-commercial use).

1. Install Tailscale on the PC (`winget install tailscale.tailscale`) and the
   Android app on the tablet. Sign in to the same account on both.
2. Find the PC's Tailscale address or name in the Tailscale app.
3. On the tablet, under **Settings → Personalize → Storage → Sync with your PC**, use that
   address with port `7878` in place of the home address.

You get:

- **Sync anywhere.** The tablet reaches the hub from any network, not just home
  Wi-Fi.
- **A fixed address.** The Tailscale address doesn't change, so you don't need
  the DHCP reservation for this.
- **Your PC's model from the tablet.** Make the model server listen on the network
  ([Using it from the tablet](#using-it-from-the-tablet)), then use the PC's
  Tailscale address in the tablet's **Settings → AI**.

### Tailscale Funnel instead of ngrok

Tailscale on its own doesn't help this Grok Bot setup, because the Bot's
remote/cloud computer isn't one of your devices. **Funnel** publishes one local
port at a fixed public
`https://<pc-name>.<your-tailnet>.ts.net` address, which does the same job as
ngrok in Part 3:

```bash
tailscale funnel 7880
```

The first run prints a link to turn Funnel on for your account. Use the printed
address as `public_base_url` and in the GitHub OAuth app (Part 3, steps 4 and 5),
with `/mcp` on the end in Grok Bot.

---

## Troubleshooting

| What you see | Likely cause |
| --- | --- |
| The Agent panel says *LLM offline* | The model server isn't running, or the URL or model name is wrong. Open the URL plus `/models` in a browser; it should list your model. |
| Tablet can't reach the PC's model | The server is only listening on the PC. See [Using it from the tablet](#using-it-from-the-tablet). |
| `401` from the MCP URL | Expected until you sign in. From outside, only a GitHub sign-in through the bridge works. If Grok can't connect, remove the connector in Grok and add it again. |
| GitHub says the redirect URI is wrong | The OAuth app's callback must be exactly `https://your-domain.ngrok-free.dev/auth/callback`. |
| Grok reports `404` on sign-in | ngrok is pointed at 7879 (`lc mcp`) instead of 7880 (the bridge), or the bridge isn't running. |
| `ChatBot OAuth setup: …` when starting the bridge | The settings file is missing a field, or a path points outside the project. The message names the problem. |
| `403` from the MCP URL | The client sent a browser `Origin` header, which the server refuses. Use a server-side connector, not a browser page. |
| ngrok shows `ERR_NGROK_8012` | The bridge isn't running on port 7880. |
| Tools fail after signing in | `lc mcp --listen` isn't running on port 7879, or the desktop app (the hub) is closed. |
| Tools work but return hub errors | The desktop app isn't running, or the hub uses a different port (pass `--hub`). |
| The footnote stays pending | Nobody has answered it yet. With **An AI assistant bot**, ask your assistant to answer pending requests. With **An assistant app on this PC**, check its status and use **Test** in ChatBot settings. |
| Test says Codex "has not been verified for automatic footnotes" | Codex was updated to a release Pen Island hasn't checked. Install a version on `VERIFIED_CODEX_VERSIONS` (0.162.1 or 0.163.0), or choose Claude Code under **App**. |
| Test says to sign in to Claude Code | Run `claude` on the PC and sign in with your claude.ai account. An API key isn't accepted in this mode. |
| A page run says page runs need an assistant | **Your AI model** writes single footnotes only. Switch to an assistant mode for page runs. |
| Tablet stopped syncing after a router restart | The PC got a new address. Update it on the tablet, and add a [DHCP reservation](#keep-the-pcs-address-from-changing). |
| Tablet can't reach the hub over Tailscale | Windows Firewall may block port `7878` on the Tailscale network. Allow it for that network. |
| `lc` says `mcp` isn't a command | Your `lc` is old. Rebuild it with `cargo install --path .`. |
