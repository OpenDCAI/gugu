package app.gugu.chat;

import org.junit.Test;
import static org.junit.Assert.*;

public class PhoneAgentNotificationPolicyTest {
    private static final String OWNER = "66a943dd-7452-412c-bfca-1b4f74346c46";
    private static final String HOST = "279fb3e0-b1df-49da-a8ae-5b16ded76550";
    private static final String SESSION = "13226587-813a-4e58-a023-dc419aeab890";
    private static final String JOB = "13226587-813a-4e58-a023-dc419aeab891";
    private static final String OTHER = "13226587-813a-4e58-a023-dc419aeab892";

    @Test public void stopRequiresTheCurrentOwnerHostSessionAndJob() {
        PhoneAgentNotificationPolicy.Execution current = PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "model");
        assertTrue(PhoneAgentNotificationPolicy.canStop(current, OWNER, HOST, SESSION, JOB));
        assertFalse(PhoneAgentNotificationPolicy.canStop(current, OTHER, HOST, SESSION, JOB));
        assertFalse(PhoneAgentNotificationPolicy.canStop(current, OWNER, OTHER, SESSION, JOB));
        assertFalse(PhoneAgentNotificationPolicy.canStop(current, OWNER, HOST, OTHER, JOB));
        assertFalse(PhoneAgentNotificationPolicy.canStop(current, OWNER, HOST, SESSION, OTHER));
        assertFalse(PhoneAgentNotificationPolicy.canStop(null, OWNER, HOST, SESSION, JOB));
    }

    @Test public void aNewJobInTheSameSessionRejectsTheOldNotification() {
        PhoneAgentNotificationPolicy.Execution newer = PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, OTHER, "tool");
        assertFalse(PhoneAgentNotificationPolicy.canStop(newer, OWNER, HOST, SESSION, JOB));
        assertTrue(PhoneAgentNotificationPolicy.canStop(newer, OWNER, HOST, SESSION, OTHER));
    }

    @Test public void malformedExecutionCannotCreateAStopTarget() {
        assertNull(PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, "../job", "model"));
        assertNull(PhoneAgentNotificationPolicy.execution(OWNER, HOST, "1-1-1-1-1", JOB, "tool"));
        assertNull(PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "private task content"));
        assertNull(PhoneAgentNotificationPolicy.execution(null, HOST, SESSION, JOB, "model"));
    }

    @Test public void stoppingExecutionCannotBeStoppedAgain() {
        PhoneAgentNotificationPolicy.Execution current = PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "tool");
        assertFalse(PhoneAgentNotificationPolicy.canStop(current.stopping(), OWNER, HOST, SESSION, JOB));
        assertEquals("手机任务正在取消", PhoneAgentNotificationPolicy.title("ready", true, current.stopping(), 0));
    }

    @Test public void notificationUsesOnlyRealPhaseAndAggregateWaitingState() {
        assertEquals("手机任务正在准备", PhoneAgentNotificationPolicy.title("ready", true, PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "preparing"), 0));
        assertEquals("手机任务正在生成回复", PhoneAgentNotificationPolicy.title("ready", true, PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "model"), 0));
        assertEquals("手机任务正在执行工具", PhoneAgentNotificationPolicy.title("ready", true, PhoneAgentNotificationPolicy.execution(OWNER, HOST, SESSION, JOB, "tool"), 0));
        assertEquals("当前没有正在运行的任务", PhoneAgentNotificationPolicy.detail("ready", true, null, 0));
        assertEquals("手机任务等你处理", PhoneAgentNotificationPolicy.title("ready", true, null, 2));
        assertTrue(PhoneAgentNotificationPolicy.detail("ready", true, null, 2).contains("2"));
    }

    @Test public void connectionFailureNeverLooksLikeIdleSuccess() {
        assertEquals("手机 Agent 宿主连接失败", PhoneAgentNotificationPolicy.title("failed", false, null, 0));
        assertEquals("手机 Agent 正在连接", PhoneAgentNotificationPolicy.title("starting", false, null, 0));
        assertEquals("手机 Agent 宿主已停止", PhoneAgentNotificationPolicy.title("stopped", false, null, 0));
    }
}
