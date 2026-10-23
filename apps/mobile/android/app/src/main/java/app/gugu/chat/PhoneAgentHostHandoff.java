package app.gugu.chat;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.function.BooleanSupplier;

/** A superseded waiter still inherits the predecessor's proven exit barrier. */
final class PhoneAgentHostHandoff {
    private PhoneAgentHostHandoff() {}

    /** Mark only the stdout read boundary, never event handling or resource cleanup. */
    static String readLine(BufferedReader reader, BooleanSupplier stopping) throws IOException {
        try { return reader.readLine(); }
        catch (IOException error) {
            String message = error.getMessage() == null ? "" : error.getMessage().toLowerCase(Locale.ROOT);
            if (stopping.getAsBoolean() && ("read interrupted".equals(message) || "stream closed".equals(message) || "pipe closed".equals(message)))
                throw new StopPipeClosed(error);
            throw error;
        }
    }

    private static final class StopPipeClosed extends IOException {
        StopPipeClosed(IOException cause) { super(cause.getMessage(), cause); }
    }

    static Throwable finishFailure(boolean stopRequested, CompletableFuture<Void> exitProof, Throwable runFailure, Throwable cleanupFailure) {
        Throwable error = runFailure;
        while (error instanceof CompletionException && error.getCause() != null) error = error.getCause();
        boolean provenExit = exitProof.isDone() && !exitProof.isCompletedExceptionally() && !exitProof.isCancelled();
        if (stopRequested && provenExit && error instanceof StopPipeClosed && error.getSuppressed().length == 0) error = null;
        if (cleanupFailure != null) {
            if (error == null) error = cleanupFailure;
            else if (error != cleanupFailure) error.addSuppressed(cleanupFailure);
        }
        if (!provenExit && error == null) error = new IllegalStateException("手机运行时尚未确认退出");
        if (!stopRequested && error == null) error = new IllegalStateException("手机运行时已退出");
        return error;
    }

    /** Runtime/reporting errors do not invalidate a separately proven process exit. */
    static CompletableFuture<Void> confirmExit(CompletableFuture<Void> previousExit, boolean childExited, Throwable runFailure) {
        CompletableFuture<Void> proof = new CompletableFuture<>();
        boolean previousExited = previousExit.isDone() && !previousExit.isCompletedExceptionally() && !previousExit.isCancelled();
        if (previousExited && childExited) proof.complete(null);
        else proof.completeExceptionally(new IllegalStateException(previousExited ? "手机运行时尚未确认退出" : "上一个手机运行时尚未确认退出", runFailure));
        return proof;
    }

    static CompletableFuture<Void> startAfterExit(CompletableFuture<Void> previousExit, CompletableFuture<Void> deadline, Executor executor, BooleanSupplier current, Runnable start) {
        CompletableFuture<Void> confirmedExit = new CompletableFuture<>();
        previousExit.whenComplete((ignored, error) -> { if (error == null) confirmedExit.complete(null); else confirmedExit.completeExceptionally(error); });
        deadline.whenComplete((ignored, error) -> { if (error != null) confirmedExit.completeExceptionally(error); });
        try { return confirmedExit.thenRunAsync(() -> { if (current.getAsBoolean()) start.run(); }, executor); }
        catch (RuntimeException error) {
            CompletableFuture<Void> failed = new CompletableFuture<>();
            failed.completeExceptionally(error);
            return failed;
        }
    }
}
