package app.gugu.chat;

/** A GoTrue failure code is needed by the existing session coordinator's expiry policy. */
final class GuguAgentHostAuthException extends RuntimeException {
    final String code;
    GuguAgentHostAuthException(String code, String message) { super(message); this.code = code == null || code.isEmpty() ? "failed" : code; }
}
