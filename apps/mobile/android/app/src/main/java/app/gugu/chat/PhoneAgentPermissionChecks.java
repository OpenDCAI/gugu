package app.gugu.chat;

import java.util.List;

/** Category admission and data delivery deliberately have different proof requirements. */
final class PhoneAgentPermissionChecks {
    private PhoneAgentPermissionChecks() {}

    interface Check<T> { void check(T value) throws Exception; }

    static void preflight(List<String> groups, Check<String> grant) throws Exception {
        for (String group : groups) grant.check(group);
    }

    static <P> void delivery(List<String> groups, List<P> proofs, Check<String> grant, Check<String> legacy, Check<P> proof) throws Exception {
        for (String group : groups) {
            grant.check(group);
            if (proofs == null || proofs.isEmpty()) legacy.check(group);
        }
        if (proofs != null) for (P entry : proofs) proof.check(entry);
    }
}
