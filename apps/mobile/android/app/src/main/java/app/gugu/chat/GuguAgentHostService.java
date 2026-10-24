package app.gugu.chat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.IBinder;
import com.getcapacitor.JSObject;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Native lifetime for the owner-scoped headless host; no WebView timers or network are required. */
public class GuguAgentHostService extends Service {
    private static final Object LOCK = new Object();
    private static final Map<String, JSObject> STATES = new HashMap<>();
    private static volatile GuguAgentHostService active;
    private static volatile String reservedOwner;
    private static final String ACTION_CANCEL_NOTIFICATION_TASK = "app.gugu.chat.action.CANCEL_PHONE_AGENT_TASK";
    private volatile String notificationSignature;
    private final ExecutorService work = Executors.newCachedThreadPool();
    private final ScheduledExecutorService timers = Executors.newSingleThreadScheduledExecutor();
    private volatile HostRun current;

    @Override public IBinder onBind(Intent intent) { return null; }

    static void reserveOwner(String owner) {
        synchronized (LOCK) { reservedOwner = GuguAgentHostPolicy.owner(owner); }
    }
    static void releaseReservation(String owner) {
        synchronized (LOCK) { if (owner.equals(reservedOwner)) reservedOwner = null; }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(startId); return START_NOT_STICKY; }
        // An old notification must never configure a host, change accounts or cancel a newer job.
        if (ACTION_CANCEL_NOTIFICATION_TASK.equals(intent.getAction())) {
            HostRun run = current;
            if (run == null) stopSelf(startId);
            else {
                run.startId = startId;
                work.execute(() -> run.cancelFromNotification(intent));
            }
            return START_NOT_STICKY;
        }
        if ("stop".equals(intent.getAction())) {
            String owner = intent.getStringExtra("ownerId");
            HostRun run = current;
            if (run != null && run.owner.equals(owner)) run.stop();
            else if (run == null) stopSelf(startId);
            return START_NOT_STICKY;
        }
        try {
            String owner = GuguAgentHostPolicy.owner(intent.getStringExtra("ownerId"));
            JSObject config = GuguAgentHostStore.read(this, owner);
            if (config == null) throw new IllegalStateException("手机宿主尚未配置");
            HostRun running = current;
            if (running == null || !running.owner.equals(owner) || !running.alive()) foreground("手机 Agent 正在连接", "点此查看这台手机上的 Agent");
            HostRun previous = null;
            HostRun configured;
            boolean launch;
            synchronized (LOCK) {
                active = this;
                HostRun run = current;
                if (run != null && run.owner.equals(owner) && !run.stopping && run.alive()) {
                    run.config = config;
                    run.startId = startId;
                    configured = run;
                    launch = false;
                } else {
                    previous = run;
                    configured = new HostRun(owner, config, startId);
                    current = configured;
                    launch = true;
                }
            }
            if (launch) {
                Exception setupFailure = null;
                try {
                    if (previous != null) {
                        previous.stop();
                        if (!previous.owner.equals(owner)) GuguAgentHostStore.clear(this, previous.owner);
                    }
                    configured.state("starting", false, "正在启动手机运行时");
                } catch (Exception error) { setupFailure = error; }
                configured.startAfter(previous, setupFailure);
            }
            else configured.sendConfiguration();
        } catch (Exception error) {
            android.util.Log.e("GuguAgentHost", "Cannot configure phone host: " + error.getClass().getSimpleName());
            String owner = intent.getStringExtra("ownerId");
            if (owner != null) releaseReservation(owner);
            stopSelf(startId);
        }
        // A user-disabled or force-stopped App is offline. Do not advertise automatic recovery.
        return START_NOT_STICKY;
    }

    static JSObject readState(Context context, String owner) throws Exception {
        GuguAgentHostPolicy.owner(owner);
        synchronized (LOCK) {
            JSObject saved = STATES.get(owner);
            if (saved == null) {
                File file = stateFile(context, owner);
                try {
                    saved = file.exists() ? new JSObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8))
                        : new JSObject().put("ownerId", owner).put("status", "stopped").put("sessions", new JSONArray());
                } catch (org.json.JSONException error) {
                    saved = new JSObject().put("ownerId", owner).put("status", "failed").put("ready", false)
                        .put("message", "手机宿主设置已损坏，请重新连接").put("sessions", new JSONArray());
                }
            }
            JSObject out = new JSObject(saved.toString());
            HostRun run = active == null ? null : active.current;
            boolean live = run != null && run.owner.equals(owner) && !run.stopping && run.alive();
            out.put("serviceAlive", live).put("runtimeReady", live && out.optBoolean("ready"));
            if (!live) {
                if (owner.equals(reservedOwner)) out.put("status", "starting");
                else if (out.optBoolean("ready") || "starting".equals(out.optString("status"))) out.put("status", "interrupted");
                out.put("ready", false);
            }
            return out;
        }
    }

    static CompletableFuture<JSObject> requestAuth(String owner, String refreshToken, String action) {
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run == null || run.stopping || !run.alive() || (reservedOwner != null && !reservedOwner.equals(run.owner))) {
            if (reservedOwner != null) {
                CompletableFuture<JSObject> starting = new CompletableFuture<>();
                starting.completeExceptionally(new IllegalStateException(owner != null && !owner.equals(reservedOwner) ? "登录会话不属于当前手机宿主" : "手机宿主正在启动，登录续期尚未就绪"));
                return starting;
            }
            return CompletableFuture.completedFuture(new JSObject().put("available", false).put("session", JSONObject.NULL));
        }
        if (owner != null && !owner.equals(run.owner)) {
            CompletableFuture<JSObject> failed = new CompletableFuture<>();
            failed.completeExceptionally(new SecurityException("登录会话不属于当前手机宿主"));
            return failed;
        }
        String id = UUID.randomUUID().toString();
        CompletableFuture<JSObject> result = new CompletableFuture<>();
        run.auth.put(id, result);
        JSObject request = new JSObject().put("type", "auth_request").put("ownerId", run.owner).put("id", id).put("action", action);
        if (refreshToken != null) request.put("refreshToken", refreshToken);
        if (!run.send(request)) {
            run.auth.remove(id);
            result.completeExceptionally(new IllegalStateException("手机宿主尚未连接"));
        } else {
            service.timers.schedule(() -> {
                if (run.auth.remove(id, result)) result.completeExceptionally(new IllegalStateException("手机宿主登录续期超时"));
            }, 25, TimeUnit.SECONDS);
        }
        return result;
    }

    static void webActionResult(String owner, String id, JSONObject result) {
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run == null || run.stopping || !run.owner.equals(owner)) throw new SecurityException("动作不属于当前手机宿主");
        JSObject request = run.webActions.remove(id);
        if (request == null) throw new IllegalArgumentException("手机动作已结束或超时");
        run.toolResult(request, result);
    }

    static void cancelSession(String owner, String sessionId) {
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run == null || run.stopping || !run.owner.equals(owner)) throw new IllegalStateException("手机宿主尚未连接");
        if (!run.send(new JSObject().put("type", "cancel").put("ownerId", owner).put("sessionId", sessionId)))
            throw new IllegalStateException("手机运行时尚未连接");
    }

    static CompletableFuture<JSObject> hostCall(String owner, String id, String channel, JSONArray args) {
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run == null || run.stopping || !run.owner.equals(owner)) return failed(new IllegalStateException("手机宿主尚未连接"));
        JSObject request = new JSObject().put("type", "host_call").put("source", "native-ui").put("ownerId", owner).put("id", id).put("channel", channel).put("args", args);
        PendingCall pending = new PendingCall(request.toString());
        PendingCall existing = run.calls.putIfAbsent(id, pending);
        if (existing != null) return existing.signature.equals(pending.signature) ? existing.result : failed(new IllegalArgumentException("同一请求编号不能用于另一项操作"));
        if (!run.send(request)) { run.calls.remove(id, pending); pending.result.completeExceptionally(new IllegalStateException("手机运行时尚未连接")); }
        else service.timers.schedule(() -> {
            if (run.calls.remove(id, pending)) pending.result.completeExceptionally(new IllegalStateException("手机宿主未在时限内返回，请用同一请求编号重试"));
        }, 120, TimeUnit.SECONDS);
        return pending.result;
    }

    private static CompletableFuture<JSObject> failed(Throwable error) { CompletableFuture<JSObject> value = new CompletableFuture<>(); value.completeExceptionally(error); return value; }
    private static final class PendingCall {
        final String signature;
        final CompletableFuture<JSObject> result = new CompletableFuture<>();
        PendingCall(String signature) { this.signature = signature; }
    }

    static CompletableFuture<Void> stopOwnerAndWait(Context context, String owner, boolean clearCredentials) throws Exception {
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run == null || !run.owner.equals(owner)) { stopOwner(context, owner, clearCredentials); return CompletableFuture.completedFuture(null); }
        var grants = GuguAgentService.permissions(context);
        if (owner.equals(grants.getString("owner", ""))) { grants.edit().clear().commit(); GuguNotificationListener.setCollecting(false); }
        run.closingAuth = true;
        run.stop();
        return run.exited.thenRun(() -> {
            try { if (clearCredentials) GuguAgentHostStore.clear(context, owner); }
            catch (Exception error) { throw new java.util.concurrent.CompletionException(error); }
            finally { releaseReservation(owner); }
        });
    }

    static void stopOwner(Context context, String owner, boolean clearCredentials) throws Exception {
        GuguAgentHostPolicy.owner(owner);
        // Revoke before stopping the loop, so an in-flight native read cannot deliver after logout.
        var grants = GuguAgentService.permissions(context);
        if (owner.equals(grants.getString("owner", ""))) { grants.edit().clear().commit(); GuguNotificationListener.setCollecting(false); }
        GuguAgentHostService service = active;
        HostRun run = service == null ? null : service.current;
        if (run != null && run.owner.equals(owner)) { run.closingAuth = false; run.stop(); }
        releaseReservation(owner);
        if (clearCredentials) GuguAgentHostStore.clear(context, owner);
    }

    private final class HostRun {
        final String owner;
        final String notificationNonce = UUID.randomUUID().toString();
        volatile PhoneAgentNotificationPolicy.Execution notificationExecution;
        volatile String notificationCancelJob;
        volatile String notificationHostStatus = "starting";
        volatile boolean notificationReady;
        volatile int notificationWaitingTasks;
        volatile JSObject config;
        volatile Process process;
        volatile BufferedWriter stdin;
        volatile boolean stopping;
        volatile boolean closingAuth;
        volatile int startId;
        final Map<String, CompletableFuture<JSObject>> auth = new ConcurrentHashMap<>();
        final Map<String, PendingCall> calls = new ConcurrentHashMap<>();
        final Map<String, JSObject> webActions = new ConcurrentHashMap<>();
        final CompletableFuture<Void> exited = new CompletableFuture<>();
        volatile CompletableFuture<Void> previousExit = CompletableFuture.completedFuture(null);
        final PhoneAgentActionExecutor actions = new PhoneAgentActionExecutor(GuguAgentHostService.this);

        HostRun(String owner, JSObject config, int startId) { this.owner = owner; this.config = config; this.startId = startId; }
        boolean alive() { Process child = process; return !stopping && (child == null ? current == this : child.isAlive()); }
        boolean isCurrent() { return current == this && !stopping; }

        void startAfter(HostRun previous, Throwable setupFailure) {
            CompletableFuture<Void> previousExit = previous == null ? CompletableFuture.completedFuture(null) : previous.exited;
            this.previousExit = previousExit;
            CompletableFuture<Void> deadline = new CompletableFuture<>();
            if (previous != null) {
                try {
                    ScheduledFuture<?> timeout = timers.schedule(() -> deadline.completeExceptionally(
                        new TimeoutException("上一个手机运行时未在限期内确认退出，未启动新运行时")), previous.closingAuth ? 40 : 10, TimeUnit.SECONDS);
                    previousExit.whenComplete((ignored, error) -> timeout.cancel(false));
                } catch (RuntimeException error) { deadline.completeExceptionally(error); }
            }
            // Register outside LOCK; completing a future may synchronously invoke cleanup.
            PhoneAgentHostHandoff.startAfterExit(previousExit, deadline, work, this::isCurrent, () -> {
                if (setupFailure != null) throw new CompletionException(setupFailure);
                run();
            }).whenComplete((ignored, error) -> finish(error));
        }

        void run() {
            try {
                synchronized (LOCK) {
                    if (!isCurrent()) return;
                    // Keep the ownership check and child creation atomic with stop/reconfigure.
                    process = GuguAgentRuntime.start(GuguAgentHostService.this, owner, true);
                }
                if (stopping) return;
                stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
                work.execute(() -> {
                    try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) android.util.Log.w("GuguAgentHost", redact(line));
                    } catch (Exception ignored) { /* the owned child closes this pipe on exit */ }
                });
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = PhoneAgentHostHandoff.readLine(reader, () -> stopping)) != null) event(new JSObject(line));
                }
                if (!stopping) state("failed", false, "手机运行时已退出");
            } catch (Exception error) {
                throw new CompletionException(error);
            }
        }

        void finish(Throwable failure) {
            boolean stopRequested = stopping;
            Throwable cleanupFailure = null;
            stopping = true;
            try {
                if (process != null && process.isAlive()) {
                    process.destroy();
                    if (!process.waitFor(2, TimeUnit.SECONDS)) { process.destroyForcibly(); if (!process.waitFor(3, TimeUnit.SECONDS)) throw new IllegalStateException("手机运行时未退出"); }
                }
            } catch (Exception cleanupError) { cleanupFailure = cleanupError; }
            try { actions.close(); }
            catch (Exception cleanupError) { if (cleanupFailure == null) cleanupFailure = cleanupError; else cleanupFailure.addSuppressed(cleanupError); }
            stdin = null;
            auth.values().forEach(pending -> pending.completeExceptionally(new IllegalStateException("手机宿主已停止")));
            calls.values().forEach(pending -> pending.result.completeExceptionally(new IllegalStateException("手机宿主已停止")));
            auth.clear(); calls.clear(); webActions.clear();
            // Admission safety depends on process exits, independently of why this run failed.
            CompletableFuture<Void> exitProof = PhoneAgentHostHandoff.confirmExit(previousExit, process == null || !process.isAlive(), failure == null ? cleanupFailure : failure);
            Throwable error = PhoneAgentHostHandoff.finishFailure(stopRequested, exitProof, failure, cleanupFailure);
            try {
                if (current == this) {
                    if (error != null) state("failed", false, redact(error.getMessage()));
                    else state("stopped", false, "手机宿主已停止");
                }
            } catch (Exception reportingError) { if (error == null) error = reportingError; else error.addSuppressed(reportingError); }
            try {
                synchronized (LOCK) {
                    // Retain only an unproven exit; a failed but terminated run may be retried.
                    if (current == this) {
                        releaseReservation(owner);
                        if (!exitProof.isCompletedExceptionally()) { current = null; if (active == GuguAgentHostService.this) active = null; stopSelfResult(startId); }
                    }
                }
            } catch (Exception cleanupError) { if (error == null) error = cleanupError; else error.addSuppressed(cleanupError); }
            finally {
                // A diagnostic failure must never masquerade as an unproven child exit.
                exitProof.whenComplete((ignored, exitFailure) -> {
                    if (exitFailure == null) exited.complete(null);
                    else exited.completeExceptionally(exitFailure);
                });
            }
        }

        void event(JSObject event) throws Exception {
            String type = event.optString("type");
            if ("ready".equals(type)) { if (isCurrent()) sendConfiguration(); return; }
            if (!isCurrent() && !(closingAuth && current == this && "auth_session".equals(type))) return;
            if (!owner.equals(event.optString("ownerId"))) throw new SecurityException("手机运行时事件缺少当前账号归属");
            if ("auth_session".equals(type)) {
                synchronized (LOCK) {
                    if (!isCurrent() && !(closingAuth && current == this)) return;
                    config = GuguAgentHostStore.updateSession(GuguAgentHostService.this, owner, event.getJSONObject("session"));
                }
            } else if ("auth_result".equals(type)) {
                CompletableFuture<JSObject> pending = auth.remove(event.optString("id"));
                if (pending == null) return;
                JSONObject session = event.optJSONObject("session");
                if (session != null) {
                    try {
                        boolean signedOut = event.optBoolean("signedOut");
                        synchronized (LOCK) {
                            if (!isCurrent()) throw new IllegalStateException("手机宿主已停止");
                            config = GuguAgentHostStore.updateSession(GuguAgentHostService.this, owner, session);
                        }
                        if (signedOut) stopOwner(GuguAgentHostService.this, owner, true);
                        pending.complete(new JSObject().put("available", true).put("session", session).put("signedOut", signedOut));
                    } catch (Exception error) { pending.completeExceptionally(error); throw error; }
                } else {
                    JSONObject error = event.optJSONObject("error");
                    pending.completeExceptionally(new GuguAgentHostAuthException(error == null ? "failed" : error.optString("code", "failed"), redact(error == null ? event.optString("message", "手机宿主登录续期失败") : error.optString("message"))));
                }
            } else if ("host_result".equals(type)) {
                PendingCall pending = calls.remove(event.optString("id"));
                if (pending != null) {
                    JSObject result = new JSObject();
                    if (event.has("result")) result.put("result", event.get("result"));
                    if (event.optJSONObject("error") != null) result.put("error", new JSONObject(redact(event.getJSONObject("error").toString())));
                    pending.result.complete(result);
                }
            } else if ("native_tool".equals(type)) {
                if (event.optString("sessionId").isEmpty() || event.optString("id").isEmpty()) throw new SecurityException("手机工具缺少会话归属");
                work.execute(() -> executeTool(event));
            } else if ("host_state".equals(type) || "host_ready".equals(type)) {
                JSObject safe = sanitize(event);
                boolean ready = "host_ready".equals(type) || ("ready".equals(safe.optString("status")) && safe.optBoolean("ready"));
                safe.put("status", ready ? "ready" : safe.optString("status", "starting")).put("ready", ready);
                persist(safe);
                notificationHostStatus = safe.optString("status", "starting");
                notificationReady = ready;
                JSONObject execution = event.optJSONObject("execution");
                PhoneAgentNotificationPolicy.Execution next = execution == null ? null : PhoneAgentNotificationPolicy.execution(
                    owner, notificationNonce, execution.optString("sessionId"), execution.optString("jobId"), execution.optString("phase"));
                if (next == null || !next.jobId.equals(notificationCancelJob)) notificationCancelJob = null;
                notificationExecution = next;
                notificationWaitingTasks = waitingTasks(safe.optJSONArray("sessions"));
                refreshNotification();
            }
        }

        void refreshNotification() {
            synchronized (LOCK) {
                if (current != this) return;
                PhoneAgentNotificationPolicy.Execution execution = notificationExecution;
                if (execution != null && execution.jobId.equals(notificationCancelJob)) execution = execution.stopping();
                foreground(this, execution);
            }
        }

        void cancelFromNotification(Intent intent) {
            PhoneAgentNotificationPolicy.Execution execution;
            synchronized (LOCK) {
                execution = notificationExecution;
                if (!isCurrent() || (reservedOwner != null && !owner.equals(reservedOwner))
                    || !PhoneAgentNotificationPolicy.canStop(execution, intent.getStringExtra("ownerId"), intent.getStringExtra("hostNonce"), intent.getStringExtra("sessionId"), intent.getStringExtra("jobId"))
                    || execution.jobId.equals(notificationCancelJob)) return;
                notificationCancelJob = execution.jobId;
            }
            boolean sent = send(new JSObject().put("type", "cancel").put("ownerId", owner).put("sessionId", execution.sessionId).put("jobId", execution.jobId));
            synchronized (LOCK) {
                if (!sent && execution.jobId.equals(notificationCancelJob)) notificationCancelJob = null;
            }
            refreshNotification();
        }

        void sendConfiguration() {
            if (!isCurrent()) return;
            try { send(new JSObject(config.toString()).put("type", "configure")); }
            catch (Exception error) { state("failed", false, "无法发送手机宿主配置"); }
        }

        void executeTool(JSObject event) {
            try {
                if (!isCurrent()) throw new SecurityException("手机宿主已停止");
                String name = event.getString("name");
                JSONObject args = event.optJSONObject("args");
                if (args == null) args = new JSONObject();
                if ("device.action".equals(name)) {
                    name = args.getString("action");
                    args = args.optJSONObject("args");
                    if (args == null) args = new JSONObject();
                }
                if ("phone.native".equals(name)) {
                    executeRaw(event, args);
                } else if ("permissions.preflight".equals(name) || "permissions.check".equals(name)) {
                    JSONArray requested = args.getJSONArray("groups");
                    List<String> groups = new ArrayList<>();
                    for (int index = 0; index < requested.length(); index++) groups.add(requested.getString(index));
                    if ("permissions.preflight".equals(name)) {
                        PhoneAgentPermissionChecks.preflight(groups, this::requireGrant);
                    } else {
                        JSONArray requirements = args.optJSONArray("requirements");
                        List<JSONObject> proofs = null;
                        if (requirements != null) {
                            proofs = new ArrayList<>();
                            for (int index = 0; index < requirements.length(); index++) proofs.add(requirements.getJSONObject(index));
                        }
                        PhoneAgentPermissionChecks.delivery(groups, proofs, this::requireGrant, this::requireLegacyDeliveryPermission,
                            (proof) -> PhoneAgentPermissionProof.check(GuguAgentHostService.this, proof));
                    }
                    toolResult(event, new JSObject().put("ok", true));
                } else if ("calendar.events.list".equals(name)) {
                    requireGrant("calendar");
                    long[] range;
                    if (args.has("start_ms") && args.has("end_ms")) range = new long[] { args.getLong("start_ms"), args.getLong("end_ms") };
                    else range = CalendarReadRange.resolve(args.has("date") ? args.getString("date") : null,
                        args.has("start") ? args.getString("start") : null, args.has("end") ? args.getString("end") : null,
                        java.time.ZoneId.systemDefault(), java.time.Instant.now());
                    JSObject data = PhoneCalendarReader.read(GuguAgentHostService.this, range[0], range[1], args.optInt("limit", 100));
                    requireGrant("calendar");
                    toolResult(event, new JSObject().put("ok", true).put("data", data));
                } else if ("contacts.list".equals(name)) {
                    requireGrant("contacts");
                    JSObject data = PhoneContactsReader.read(GuguAgentHostService.this, args.optString("query", null), args.optInt("limit", 50));
                    requireGrant("contacts");
                    toolResult(event, new JSObject().put("ok", true).put("data", data));
                } else if ("notifications.list".equals(name)) {
                    requireGrant("notifications");
                    int limit = args.optInt("limit", 30);
                    if (limit < 1 || limit > 200) throw new IllegalArgumentException("通知条数要在 1–200");
                    String app = args.optString("app", "").trim().toLowerCase(java.util.Locale.ROOT);
                    JSONArray rows = PhoneNotificationsReader.read(GuguAgentHostService.this, app.isEmpty() ? limit : 200).getJSONArray("notifications");
                    JSONArray filtered = new JSONArray();
                    for (int i = 0; i < rows.length() && filtered.length() < limit; i++) {
                        JSONObject row = rows.getJSONObject(i);
                        if (!app.isEmpty() && !row.optString("app").toLowerCase(java.util.Locale.ROOT).contains(app) && !row.optString("package").toLowerCase(java.util.Locale.ROOT).equals(app)) continue;
                        filtered.put(new JSObject().put("app", row.optString("app")).put("package", row.optString("package")).put("title", row.optString("title"))
                            .put("text", row.optString("text")).put("active", row.optBoolean("active"))
                            .put("posted_at", java.time.Instant.ofEpochMilli(row.getLong("posted_at")).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX"))));
                    }
                    requireGrant("notifications");
                    toolResult(event, new JSObject().put("ok", true).put("data", new JSObject().put("notifications", filtered)));
                } else {
                    // Existing actions retain their established permission and confirmation provider.
                    webActions.put(event.getString("id"), event);
                    JSObject request = new JSObject().put("id", event.getString("id")).put("ownerId", owner)
                        .put("sessionId", event.getString("sessionId")).put("action", name).put("args", args);
                    if (!GuguAgentPlugin.publishWebAction(request)) {
                        webActions.remove(event.getString("id"));
                        toolResult(event, new JSObject().put("ok", false).put("code", "device_offline").put("message", "此动作需要咕咕页面保持连接"));
                    } else timers.schedule(() -> {
                        if (webActions.remove(event.optString("id"), event)) toolResult(event, new JSObject().put("ok", false).put("code", "no_answer").put("message", "手机动作没有及时返回"));
                    }, 30, TimeUnit.SECONDS);
                }
            } catch (Exception error) {
                toolResult(event, new JSObject().put("ok", false).put("code", error instanceof PhoneNativeCall.Failure ? ((PhoneNativeCall.Failure) error).code : error instanceof ToolNotGranted ? "not_granted" : error instanceof SecurityException ? "os_permission" : error instanceof IllegalArgumentException ? "invalid_args" : "execution_failed").put("message", redact(error.getMessage())));
            }
        }

        void requireGrant(String group) {
            var grants = GuguAgentService.permissions(GuguAgentHostService.this);
            if (!isCurrent() || !owner.equals(grants.getString("owner", "")) || !grants.getBoolean(group, false)) throw new ToolNotGranted(group);
        }

        void requireLegacyDeliveryPermission(String group) {
            if ("calendar".equals(group)) requireOsPermission(android.Manifest.permission.READ_CALENDAR, "日历");
            else if ("contacts".equals(group)) requireOsPermission(android.Manifest.permission.READ_CONTACTS, "通讯录");
            else if ("notifications".equals(group)) PhoneAgentPermissionProof.checkPermission(GuguAgentHostService.this, "@notification_listener");
            else if ("sms".equals(group)) requireOsPermission(android.Manifest.permission.READ_SMS, "短信");
            else throw new PhoneNativeCall.Failure("os_permission", "交付缺少实际数据读取的权限凭据");
        }

        void executeRaw(JSObject event, JSONObject request) throws Exception {
            String plugin = request.getString("plugin");
            String method = request.getString("method");
            JSONObject args = request.optJSONObject("args");
            if (args == null) args = new JSONObject();
            String group = PhoneAgentActionExecutor.group(plugin, method, args);
            String action = PhoneAgentActionExecutor.action(plugin, method, args);
            String declaredAction = event.optString("actionName");
            if (action != null && !action.equals(declaredAction)) throw new PhoneNativeCall.Failure("invalid_args", "手机动作与原生调用不匹配");
            if ("health".equals(group) && !declaredAction.startsWith("health.")) throw new PhoneNativeCall.Failure("invalid_args", "健康调用缺少正式动作归属");
            if (PhoneAgentActionExecutor.requiresApproval(plugin, method)) requireApproval(event, declaredAction);
            if (group != null) requireGrant(group);
            JSONObject requirements = PhoneAgentPermissionProof.capture(GuguAgentHostService.this, plugin, method, args);
            PhoneAgentPermissionProof.check(GuguAgentHostService.this, requirements);
            JSObject data;
            try { data = actions.execute(plugin, method, args).get(180, TimeUnit.SECONDS); }
            catch (java.util.concurrent.TimeoutException error) { throw new PhoneNativeCall.Failure("timeout", "手机原生动作在 180 秒内未返回"); }
            catch (java.util.concurrent.ExecutionException error) {
                if (error.getCause() instanceof PhoneNativeCall.Failure) throw (PhoneNativeCall.Failure) error.getCause();
                throw error;
            }
            if (group != null) requireGrant(group);
            PhoneAgentPermissionProof.addReturnedMedia(requirements, plugin, method, args, data);
            PhoneAgentPermissionProof.check(GuguAgentHostService.this, requirements);
            toolResult(event, new JSObject().put("ok", true).put("data", data).put("permissionRequirements", requirements));
        }

        void requireApproval(JSObject event, String action) {
            JSONObject approval = event.optJSONObject("approval");
            String origin = event.optString("origin");
            boolean approved = approval != null && ("device-rpc".equals(origin)
                ? approval.optBoolean("confirmed") && !approval.optString("callId").isEmpty()
                : "phone-agent".equals(origin) && approval.optBoolean("approved") && owner.equals(approval.optString("ownerId"))
                    && action.equals(approval.optString("actionName")) && !approval.optString("requestId").isEmpty() && !approval.optString("sourceMessageId").isEmpty());
            if (!approved) throw new PhoneNativeCall.Failure("needs_confirmation", "这项手机操作需要用户在咕咕中明确确认");
        }

        void requireOsPermission(String permission, String label) {
            if (androidx.core.content.ContextCompat.checkSelfPermission(GuguAgentHostService.this, permission) != android.content.pm.PackageManager.PERMISSION_GRANTED)
                throw new SecurityException("系统已撤销" + label + "读取权限");
        }

        void toolResult(JSObject request, JSONObject result) {
            if (!isCurrent()) return;
            send(new JSObject().put("type", "tool_result").put("ownerId", owner).put("sessionId", request.optString("sessionId")).put("id", request.optString("id")).put("result", result));
        }

        synchronized boolean send(JSONObject value) {
            if (stdin == null) return false;
            try { stdin.write(value.toString()); stdin.newLine(); stdin.flush(); return true; }
            catch (Exception error) { state("failed", false, "手机运行时连接已关闭"); return false; }
        }

        void stop() {
            synchronized (LOCK) {
                if (stopping) return;
                stopping = true;
            }
            send(new JSObject().put("type", "host_stop").put("ownerId", owner));
            state("stopped", false, "手机宿主已停止");
            Process child = process;
            if (child != null) timers.schedule(child::destroy, closingAuth ? 35 : 2, TimeUnit.SECONDS);
        }

        void state(String status, boolean ready, String message) {
            notificationHostStatus = status;
            notificationReady = ready;
            if (!ready) { notificationExecution = null; notificationCancelJob = null; notificationWaitingTasks = 0; }
            persist(new JSObject().put("ownerId", owner).put("status", status).put("ready", ready).put("message", redact(message)));
            refreshNotification();
        }

        void persist(JSObject next) {
            if (current != this && !"stopped".equals(next.optString("status"))) return;
            synchronized (LOCK) {
                next.put("ownerId", owner).put("deviceId", config.optString("deviceId")).put("updatedAt", System.currentTimeMillis());
                JSObject previous = STATES.get(owner);
                if (!next.has("sessions")) {
                    next.put("sessions", previous == null ? new JSONArray() : previous.optJSONArray("sessions"));
                }
                if (!next.has("project") && previous != null && previous.has("project")) next.put("project", previous.optJSONObject("project"));
                if (!next.has("taskTimeline") && previous != null && previous.has("taskTimeline")) next.put("taskTimeline", previous.optBoolean("taskTimeline"));
                STATES.put(owner, next);
                try {
                    File target = stateFile(GuguAgentHostService.this, owner);
                    target.getParentFile().mkdirs();
                    DurablePhoneHostFile.write(target, next.toString().getBytes(StandardCharsets.UTF_8));
                } catch (Exception error) { android.util.Log.e("GuguAgentHost", "Cannot persist phone host state"); }
            }
        }

        String redact(String value) { return GuguAgentHostPolicy.publicMessage(value, config.optString("accessToken"), config.optString("refreshToken"), config.optString("supabaseAnonKey")); }
        JSObject sanitize(JSObject event) throws Exception {
            JSObject out = new JSObject().put("ownerId", owner);
            String[] keys = {"status", "ready", "message", "error", "sessions", "project", "taskTimeline", "lastHeartbeatAt"};
            for (String key : keys) if (event.has(key)) out.put(key, event.get(key));
            return new JSObject(redact(out.toString()));
        }
    }

    private static class ToolNotGranted extends SecurityException {
        ToolNotGranted(String group) { super("手机能力尚未授权: " + group); }
    }
    private static File stateFile(Context context, String owner) { return new File(context.getFilesDir(), "phone-agent/" + owner + "/host-state.json"); }
    private static int waitingTasks(JSONArray sessions) {
        int count = 0;
        if (sessions != null) for (int i = 0; i < sessions.length(); i++) {
            JSONObject session = sessions.optJSONObject(i);
            if (session != null && "needs_user".equals(session.optString("status"))) count++;
        }
        return count;
    }

    private void foreground(HostRun run, PhoneAgentNotificationPolicy.Execution execution) {
        PendingIntent cancel = null;
        if (execution != null && !"stopping".equals(execution.phase) && run.isCurrent()) {
            Intent stop = new Intent(this, GuguAgentHostService.class).setAction(ACTION_CANCEL_NOTIFICATION_TASK)
                .setData(Uri.parse("gugu-phone-task-stop://" + run.notificationNonce + "/" + execution.sessionId + "/" + execution.jobId))
                .putExtra("ownerId", execution.ownerId).putExtra("hostNonce", execution.hostNonce)
                .putExtra("sessionId", execution.sessionId).putExtra("jobId", execution.jobId);
            cancel = PendingIntent.getService(this, 7563, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        String title = PhoneAgentNotificationPolicy.title(run.notificationHostStatus, run.notificationReady, execution, run.notificationWaitingTasks);
        String text = PhoneAgentNotificationPolicy.detail(run.notificationHostStatus, run.notificationReady, execution, run.notificationWaitingTasks);
        String identity = run.notificationNonce + (execution == null ? "" : ":" + execution.sessionId + ":" + execution.jobId + ":" + execution.phase);
        foreground(title, text, cancel, identity);
    }

    private void foreground(String title, String text) { foreground(title, text, null, "starting"); }

    private void foreground(String title, String text, PendingIntent cancel, String identity) {
        String signature = title + "\n" + text + "\n" + identity + ":" + (cancel != null);
        if (signature.equals(notificationSignature)) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("phone-agent-host", "手机 Agent 宿主", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 7562, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder = new Notification.Builder(this, "phone-agent-host").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title).setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE).setShowWhen(false);
        if (cancel != null) builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "停止当前任务", cancel).build());
        startForeground(7562, builder.build());
        notificationSignature = signature;
    }
    @Override public void onDestroy() {
        HostRun run = current;
        if (run != null) { run.stop(); if (run.process != null) run.process.destroy(); }
        if (run != null) releaseReservation(run.owner);
        current = null;
        if (active == this) active = null;
        work.shutdown(); timers.shutdown();
        stopForeground(STOP_FOREGROUND_REMOVE);
        notificationSignature = null;
        super.onDestroy();
    }
}
