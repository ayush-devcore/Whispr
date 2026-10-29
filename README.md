# Whispr

Whispr is a realtime chat application with registration, sign-in, direct conversations, online presence, typing signals, file uploads, reporting, and a data-backed administration view.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. In local development, the first registered account is an administrator. In production, accounts are regular members unless the initial administrator uses the one-time setup token described below. Other users can then be found through the new-conversation search.

## Deploy

Whispr is a Node + Socket.IO application. It cannot be deployed as a Netlify static site because Netlify does not run this long-lived server or its WebSocket process. Deploy the repository to a Node host such as Render, Railway, Fly.io, or a VPS instead.

For Render, create a new **Blueprint** from the GitHub repository. The included `render.yaml` supplies the build/start commands, generates `JWT_SECRET`, and asks for `ADMIN_BOOTSTRAP_TOKEN`, `DATABASE_URL`, and TURN settings. Set `ADMIN_BOOTSTRAP_TOKEN` to a unique random value at least 32 characters long before opening the public registration page. The first person who registers with that exact value becomes the administrator; the server marks bootstrap as used in persisted state and rejects further bootstrap attempts. Users who leave that field empty create regular member accounts. Remove or rotate the setup token after the initial admin is created. Existing admin records are preserved when deploying this update.

If the initial admin account is lost, do not reset the application database. Use the host's private service console and a reviewed maintenance procedure to promote the intended account and keep `adminBootstrapUsed` set to `true`; contact the project maintainer if you do not have a safe database maintenance workflow. Never expose database credentials or the setup token in browser code, logs, source control, or support screenshots. Authentication endpoints have temporary IP and account failure limits; proxies should be configured with the correct `TRUST_PROXY_HOPS` value so client addresses are not spoofed or collapsed.

Before deploying a reviewed change, confirm the Render service is connected to the intended repository and branch, check that the deployment's commit SHA matches the reviewed GitHub commit, wait for the health check to pass, then open the service URL and verify sign-in and a synthetic test conversation. This repository's auth limits, AI quotas, presence, pending calls, and group calls are process-local; run a single app instance until those controls and Socket.IO rooms are moved to shared coordination. Do not put a production `DATABASE_URL` in a local test command.

Create a managed PostgreSQL database and set its connection URL as `DATABASE_URL` before considering a deployment production ready. The app stores its application state in a PostgreSQL JSONB record when that setting is present. Without it, the local JSON store remains enabled for development and the server warns that deployed data can be lost.

For calls across restrictive mobile and corporate networks, configure a TURN server such as coturn with its shared-secret REST authentication. Set `TURN_URL` to its `turn:`/`turns:` address and `TURN_SHARED_SECRET` to the server's secret. Whispr creates short-lived TURN credentials for the signed-in user; the long-lived secret stays on the server. Without TURN, some network pairs will not connect even though voice/video permissions and signaling work. On other Node hosts, set `PORT`, `JWT_SECRET`, and `DATABASE_URL` yourself.

## Optional AI features

Whispr's optional AI features use the official OpenAI JavaScript SDK and Responses API on the server only. OpenRouter is the configured default provider and routes the same SDK request to `https://openrouter.ai/api/v1`. For OpenRouter configure `AI_ENABLED=true`, `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and `AI_MODEL=openai/gpt-6-luna` in the server environment. To use OpenAI directly, select `AI_PROVIDER=openai`, set `OPENAI_API_KEY`, and use an OpenAI model ID such as `gpt-6-luna`. Provider selection is validated and does not fall back to another provider. OpenRouter requests require parameter-compatible upstream routing when using structured outputs; the selected GPT-6 Luna model lists JSON-schema structured-output support. Optional controls are `AI_REQUEST_TIMEOUT_MS` (20,000), `AI_MAX_OUTPUT_TOKENS` (700), `AI_MAX_CONTEXT_MESSAGES` (30), `AI_CACHE_TTL_SECONDS` (120), and `AI_DAILY_USER_LIMIT` (30). No AI key is required for normal Whispr chat; without a matching key AI endpoints report unavailable. Never put provider keys in browser code, commit them, or paste them into a chat.

Each user must opt into AI processing and select features in their profile. The disclosure says that selected message text and bounded context are sent to the configured provider. Automatic scam analysis runs only when every member of that conversation has enabled scam analysis. Results are estimates, not proof or guarantees. Requests use `store: false`, but provider abuse-monitoring retention is still subject to the provider project's data controls and policy; do not promise zero retention. See OpenAI's [data controls](https://developers.openai.com/api/docs/guides/your-data) before enabling this with sensitive conversations.

The AI layer supports smart-reply drafts, automatic/explicit scam assessments, conversation summaries, translation, draft rewriting, action extraction, and AI-assisted search. Replies are never sent automatically. Daily usage counters and scam findings are stored in the existing application state; short-lived response caches and concurrency guards are process-local, so this design assumes one application process and is not yet safe for horizontal scale. Before adding app instances, move AI single-flight/deduplication and concurrency reservations to a shared atomic store or durable job queue, make quota increments atomic across instances, and share the Socket.IO adapter so private AI result events reach sockets connected to any instance. The broader app also keeps presence, group-call state, and pending calls in process memory, so it needs shared coordination for those before multi-instance operation. Set `AI_ENABLED=false` to disable provider calls.

To run real-provider integration checks locally, set `RUN_AI_INTEGRATION=true`, `AI_ENABLED=true`, `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and `AI_MODEL=openai/gpt-6-luna` in your local PowerShell session, then run `npm run test:ai-integration`. For the OpenAI provider, use `AI_PROVIDER=openai` and `OPENAI_API_KEY`. The test sends synthetic sample data through each of the seven AI operations using the configured model and never prints provider errors or credentials. It skips when the opt-in flag or matching credentials are absent. These calls may incur provider usage charges. Do not put real conversations or personal data into this test. To skip real calls, leave `RUN_AI_INTEGRATION` unset or set it to `false`.

To diagnose OpenRouter authentication separately from model inference, set `RUN_AI_DIAGNOSTICS=true` and run `npm run ai:diagnose`. It makes only a GET request to OpenRouter's key-information endpoint and prints a sanitized status/category, endpoint host, credential-variable name/presence, and request ID when available. It never prints the credential or response body. This diagnostic does not prove that inference/model access works; use the integration test for that. Whispr reads environment variables when the Node process starts and does not load `.env` files, so restart the local server after changing its environment. In PowerShell, environment variables set in one terminal are not automatically inherited by a server running in another terminal.

In Render, the Blueprint declares `AI_PROVIDER=openrouter`, `AI_MODEL=openai/gpt-6-luna`, and a secret `OPENROUTER_API_KEY` slot. AI remains disabled by default (`AI_ENABLED=false`) until you deliberately enable it after entering the provider key in the service environment. Do not enter a key in the Blueprint YAML or repository.

To deliver incoming-call notifications while Whispr is in the background or closed, configure Web Push VAPID credentials: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` contact or your HTTPS site URL). Generate a key pair with `node --input-type=module -e "import webpush from 'web-push'; console.log(webpush.generateVAPIDKeys())"`, then add the public/private values and subject to the Render environment. Users must press the bell button once on each device/browser to grant notification permission and subscribe. Clicking a call notification opens the app to its incoming-call screen; answering still requires microphone/camera permission. Calls waiting longer than 45 seconds expire.

The app stores its runtime data in `data/whispr.json` and uploaded files in `uploads/`; attach persistent storage for both directories in production. These are intentionally ignored by Git so no user content is shipped in the repository.

## Group membership

The group creator is an administrator. Admins can add and remove users from the conversation details panel; any member can leave. Membership updates are persisted and sent to active sockets. Removing or leaving revokes access to history and removes the member from any active group call. Existing groups are migrated on startup by assigning their creator when recorded, otherwise their first existing member, as the initial admin.

## PostgreSQL integration test

The regular test suite never connects to a database. For an explicit isolated persistence test, create a separate disposable PostgreSQL database whose name ends in `_test`, then set `RUN_POSTGRES_INTEGRATION=true`, `TEST_DATABASE_URL` to its URL, and `TEST_DATABASE_NAME` to that exact database name in the same PowerShell session. Run `npm run test:postgres-integration`. The test validates the exact URL database name, requires the `_test` suffix, and refuses a URL equal to `DATABASE_URL`; it creates uniquely named synthetic accounts and records and does not drop tables or delete database state. Use a newly created test database and credentials with access only to it. Clear the opt-in variables to skip the test. The test verifies startup/schema, CRUD, group membership, read receipts, deletion, reports, and AI preferences across restart; real AI inference is covered separately by `npm run test:ai-integration`.

Uploaded files currently use the `uploads/` directory. Configure a persistent disk for it, or add an object-storage provider before scaling beyond a single persistent server. Serve the application through HTTPS so browsers permit camera and microphone access.
