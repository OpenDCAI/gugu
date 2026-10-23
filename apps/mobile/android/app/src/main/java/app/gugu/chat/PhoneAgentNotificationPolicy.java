package app.gugu.chat;

import java.util.Locale;
import java.util.UUID;

/** Notification copy and stop identity contain only runtime facts, never task content. */
final class PhoneAgentNotificationPolicy {
    static final class Execution {
        final String ownerId;
        final String hostNonce;
        final String sessionId;
        final String jobId;
        final String phase;

        private Execution(String ownerId, String hostNonce, String sessionId, String jobId, String phase) {
            this.ownerId = ownerId;
            this.hostNonce = hostNonce;
            this.sessionId = sessionId;
            this.jobId = jobId;
            this.phase = phase;
        }

        Execution stopping() { return new Execution(ownerId, hostNonce, sessionId, jobId, "stopping"); }
    }

    static Execution execution(String ownerId, String hostNonce, String sessionId, String jobId, String phase) {
        if (!validId(ownerId) || !validId(hostNonce) || !validId(sessionId) || !validId(jobId)) return null;
        if (!"preparing".equals(phase) && !"model".equals(phase) && !"tool".equals(phase) && !"stopping".equals(phase)) return null;
        return new Execution(canonical(ownerId), canonical(hostNonce), canonical(sessionId), canonical(jobId), phase);
    }

    static boolean canStop(Execution current, String ownerId, String hostNonce, String sessionId, String jobId) {
        return current != null && !"stopping".equals(current.phase)
            && current.ownerId.equals(ownerId) && current.hostNonce.equals(hostNonce)
            && current.sessionId.equals(sessionId) && current.jobId.equals(jobId);
    }

    static String title(String hostStatus, boolean ready, Execution execution, int waitingTasks) {
        if (execution != null) {
            switch (execution.phase) {
                case "preparing": return "手机任务正在准备";
                case "model": return "手机任务正在生成回复";
                case "tool": return "手机任务正在执行工具";
                case "stopping": return "手机任务正在取消";
                default: return "手机任务正在运行";
            }
        }
        if ("failed".equals(hostStatus)) return "手机 Agent 宿主连接失败";
        if ("stopped".equals(hostStatus)) return "手机 Agent 宿主已停止";
        if (ready) return waitingTasks > 0 ? "手机任务等你处理" : "这台手机的 Agent 宿主已连接";
        return "手机 Agent 正在连接";
    }

    static String detail(String hostStatus, boolean ready, Execution execution, int waitingTasks) {
        if (execution != null) return "点此回到咕咕查看任务";
        if ("failed".equals(hostStatus)) return "点此查看连接状态";
        if ("stopped".equals(hostStatus)) return "任务记录已保留，恢复宿主后可继续";
        if (ready && waitingTasks > 0) return "有 " + waitingTasks + " 个任务需要你处理，点此查看";
        if (ready) return "当前没有正在运行的任务";
        return "点此查看运行状态";
    }

    private static boolean validId(String value) {
        if (value == null) return false;
        try { return UUID.fromString(value).toString().equalsIgnoreCase(value); }
        catch (IllegalArgumentException ignored) { return false; }
    }

    private static String canonical(String value) { return value.toLowerCase(Locale.ROOT); }
}
