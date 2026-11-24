# Product usage data

Product usage events are off unless you set `T3CODE_TELEMETRY_ENABLED=true` before the server
starts. They are sent only when that is set and you also set `T3CODE_POSTHOG_KEY` and
`T3CODE_POSTHOG_HOST`. This build has no built-in PostHog key and does not send events to
`ingest.t3.codes` on its own.

When you turn events on, they are associated with a random installation identifier that T3 Code
stores for itself. The server does not read `~/.codex/auth.json`, `~/.claude.json`, or other tools'
credential files to identify you, and clients do not send hashed account or device identifiers.
Events include the provider, model, reasoning effort, permission mode, turn and request results,
duration, release channel, and token counts when available. Child-agent token counts are reported
separately from the main agent's. Model names are sent only when they appear in a provider's
public model list.

Product events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output.

## Relay connection diagnostics

Relay connection traces are off unless `T3CODE_TELEMETRY_ENABLED=true` and a trace URL, dataset,
and token are configured for that client. They are separate from product events. Depending on the
client version, traces can include connection timings, environment identifiers and the connected
machine's name. Failed spans can include error messages and stack traces; error text can quote a
value the app was handling.

`T3CODE_OTEL_SDK_DISABLED` or `OTEL_SDK_DISABLED` also stops relay tracing. Setting
`T3CODE_TELEMETRY_ENABLED=false`, or leaving it unset, stops product events and relay tracing from
the server.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

The web app in a browser, including one the `t3` CLI opens, does not read these environment
variables. When its build has relay tracing configured, it sends its own connection traces even
if the server has opted out. The browser app has no relay tracing toggle.

## Mobile app diagnostics

Crash reports are off until you turn on **Send crash reports** in **Settings > About T3 Code >
Diagnostics**. When that is on, a crash or error can send the error message, the stack trace, the
app version, and the device model and OS version. Each launch can also send startup timings, and
every report carries a random ID for the install. Reports go through the T3 Connect relay. They do
not include your threads, prompts, or connection details, but an error message can quote a value
the app was handling.

The mobile app sends relay connection traces only when its build sets a trace URL, dataset, and
token. There is no built-in Axiom endpoint. **Send crash reports** does not control these traces.
Server environment variables and managed policy do not disable mobile tracing.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the T3 Connect relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example `http://localhost:4318/v1/traces`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it;
saved endpoints are checked when the section opens. Checks send authentication headers only to
the signal's currently running endpoint and do not follow redirects. To check a new endpoint
that requires authentication, save it and restart the server first.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` environment variables override the saved
settings. An overridden signal shows **Set by environment** and names the variable that set it, and its
**Test** checks the running endpoint instead of the field. For endpoints saved here or set with `T3CODE_OTLP_*_URL`, set `T3CODE_OTLP_HEADERS` for
receivers that need authentication and `T3CODE_OTLP_PROTOCOL=http/protobuf` for receivers that do
not accept JSON. An endpoint set with `OTEL_EXPORTER_OTLP_*` takes its headers and protocol from
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_PROTOCOL` instead.
