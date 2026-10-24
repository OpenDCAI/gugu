package app.gugu.chat;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;
import static org.junit.Assert.*;

public class GuguAgentHostHandoffTest {
    @Test public void replacementCannotStartBeforePreviousExitAndRechecksCurrentAtExecution() {
        CompletableFuture<Void> previous = new CompletableFuture<>();
        Queue<Runnable> scheduled = new ArrayDeque<>();
        AtomicBoolean current = new AtomicBoolean(true);
        AtomicInteger starts = new AtomicInteger();
        CompletableFuture<Void> launch = PhoneAgentHostHandoff.startAfterExit(previous, new CompletableFuture<>(), scheduled::add, current::get, starts::incrementAndGet);
        assertTrue(scheduled.isEmpty());
        assertFalse(launch.isDone());
        previous.complete(null);
        assertEquals(1, scheduled.size());
        current.set(false);
        scheduled.remove().run();
        launch.join();
        assertEquals(0, starts.get());
    }

    @Test public void aSupersededWaiterCannotLetTheNextHostBypassTheOriginalProcess() {
        CompletableFuture<Void> originalExit = new CompletableFuture<>();
        Queue<Runnable> scheduled = new ArrayDeque<>();
        AtomicBoolean middleCurrent = new AtomicBoolean(true);
        AtomicInteger middleStarts = new AtomicInteger(), newestStarts = new AtomicInteger();
        CompletableFuture<Void> middleExit = new CompletableFuture<>();
        PhoneAgentHostHandoff.startAfterExit(originalExit, new CompletableFuture<>(), scheduled::add, middleCurrent::get, middleStarts::incrementAndGet)
            .whenComplete((ignored, error) -> { if (error == null) middleExit.complete(null); else middleExit.completeExceptionally(error); });
        middleCurrent.set(false);
        CompletableFuture<Void> newest = PhoneAgentHostHandoff.startAfterExit(middleExit, new CompletableFuture<>(), scheduled::add, () -> true, newestStarts::incrementAndGet);
        assertTrue(scheduled.isEmpty());
        assertFalse(newest.isDone());
        originalExit.complete(null);
        scheduled.remove().run();
        assertEquals(0, middleStarts.get());
        assertEquals(0, newestStarts.get());
        scheduled.remove().run();
        newest.join();
        assertEquals(1, newestStarts.get());
    }

    @Test public void failedExitNeverStartsAReplacementAndSettlesItsFuture() {
        CompletableFuture<Void> previous = new CompletableFuture<>();
        AtomicInteger dispatches = new AtomicInteger(), starts = new AtomicInteger();
        CompletableFuture<Void> launch = PhoneAgentHostHandoff.startAfterExit(previous, new CompletableFuture<>(), (task) -> dispatches.incrementAndGet(), () -> true, starts::incrementAndGet);
        IllegalStateException failure = new IllegalStateException("owned child did not exit");
        previous.completeExceptionally(failure);
        assertEquals(0, dispatches.get());
        assertEquals(0, starts.get());
        assertSame(failure, failureOf(launch));
    }

    @Test public void rejectedDispatchAndStartupFailureSettleWithoutHanging() {
        CompletableFuture<Void> previous = CompletableFuture.completedFuture(null);
        RejectedExecutionException rejection = new RejectedExecutionException("service stopped");
        Executor rejected = (task) -> { throw rejection; };
        assertSame(rejection, failureOf(PhoneAgentHostHandoff.startAfterExit(previous, new CompletableFuture<>(), rejected, () -> true, () -> fail("must not start"))));
        IllegalStateException failure = new IllegalStateException("spawn failed");
        assertSame(failure, failureOf(PhoneAgentHostHandoff.startAfterExit(previous, new CompletableFuture<>(), Runnable::run, () -> true, () -> { throw failure; })));
    }

    @Test public void anExitTimeoutSettlesStoppedWaitersAndAllTheirReplacements() {
        CompletableFuture<Void> previous = new CompletableFuture<>();
        CompletableFuture<Void> deadline = new CompletableFuture<>();
        AtomicInteger starts = new AtomicInteger();
        CompletableFuture<Void> stoppedWaiter = PhoneAgentHostHandoff.startAfterExit(previous, deadline, Runnable::run, () -> false, starts::incrementAndGet);
        CompletableFuture<Void> newest = PhoneAgentHostHandoff.startAfterExit(stoppedWaiter, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet);
        TimeoutException timeout = new TimeoutException("owned child exit timed out");
        deadline.completeExceptionally(timeout);
        assertSame(timeout, failureOf(stoppedWaiter));
        assertSame(timeout, failureOf(newest));
        assertFalse(previous.isDone());
        previous.complete(null);
        assertEquals(0, starts.get());
    }

    @Test public void failedRuntimeWithProvenExitAllowsAnExplicitRetry() {
        CompletableFuture<Void> previous = CompletableFuture.completedFuture(null);
        IllegalStateException failure = new IllegalStateException("runtime resource or reader failed");
        CompletableFuture<Void> exited = PhoneAgentHostHandoff.confirmExit(previous, true, failure);
        AtomicInteger starts = new AtomicInteger();
        PhoneAgentHostHandoff.startAfterExit(exited, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet).join();
        assertEquals(1, starts.get());
    }

    @Test public void cleanupAndReportingErrorsDoNotTurnAProvenExitIntoAProcessBarrier() {
        for (String message : new String[] { "actions.close failed", "state reporting failed" }) {
            CompletableFuture<Void> exited = PhoneAgentHostHandoff.confirmExit(CompletableFuture.completedFuture(null), true, new IllegalStateException(message));
            exited.join();
            assertFalse(exited.isCompletedExceptionally());
        }
    }

    @Test public void anUnprovenChildExitBlocksRetryEvenAfterAPreviousSuccessfulExit() {
        CompletableFuture<Void> exited = PhoneAgentHostHandoff.confirmExit(CompletableFuture.completedFuture(null), false, new IllegalStateException("child still alive"));
        AtomicInteger starts = new AtomicInteger();
        CompletableFuture<Void> retry = PhoneAgentHostHandoff.startAfterExit(exited, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet);
        assertTrue(failureOf(retry).getMessage().contains("尚未确认退出"));
        assertEquals(0, starts.get());
    }

    @Test public void missingOrFailedPredecessorProofCannotBeBypassedByAnUnstartedChild() {
        for (boolean failed : new boolean[] { false, true }) {
            CompletableFuture<Void> previous = new CompletableFuture<>();
            if (failed) previous.completeExceptionally(new TimeoutException("previous exit unproven"));
            CompletableFuture<Void> exited = PhoneAgentHostHandoff.confirmExit(previous, true, new IllegalStateException("new child was never started"));
            AtomicInteger starts = new AtomicInteger();
            CompletableFuture<Void> retry = PhoneAgentHostHandoff.startAfterExit(exited, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet);
            assertTrue(failureOf(retry).getMessage().contains("上一个"));
            assertEquals(0, starts.get());
        }
    }

    @Test public void anExplicitStopWithProvenExitsAcceptsTheRealReadInterruptedBoundary() throws Exception {
        Throwable pipeClose = readFailure(true, new IOException("read interrupted"));
        CompletableFuture<Void> proof = PhoneAgentHostHandoff.confirmExit(CompletableFuture.completedFuture(null), true, pipeClose);
        assertNull(PhoneAgentHostHandoff.finishFailure(true, proof, new CompletionException(pipeClose), null));
        AtomicInteger starts = new AtomicInteger();
        PhoneAgentHostHandoff.startAfterExit(proof, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet).join();
        assertEquals(1, starts.get());
    }

    @Test public void expectedStopPipeClosuresRequireBothAnExplicitStopAndAProvenExit() throws Exception {
        for (String message : new String[] { "read interrupted", "Stream closed", "Pipe closed" }) {
            Throwable pipeClose = readFailure(true, new IOException(message));
            for (boolean predecessorExited : new boolean[] { true, false }) {
                for (boolean childExited : new boolean[] { true, false }) {
                    CompletableFuture<Void> previous = predecessorExited ? CompletableFuture.completedFuture(null) : new CompletableFuture<>();
                    CompletableFuture<Void> proof = PhoneAgentHostHandoff.confirmExit(previous, childExited, pipeClose);
                    Throwable result = PhoneAgentHostHandoff.finishFailure(true, proof, pipeClose, null);
                    assertEquals(predecessorExited && childExited, result == null);
                    if (!predecessorExited || !childExited) {
                        AtomicInteger starts = new AtomicInteger();
                        failureOf(PhoneAgentHostHandoff.startAfterExit(proof, new CompletableFuture<>(), Runnable::run, () -> true, starts::incrementAndGet));
                        assertEquals(0, starts.get());
                    }
                }
            }
            IOException unexpected = new IOException(message);
            Throwable activeReadFailure = readFailure(false, unexpected);
            assertSame(unexpected, activeReadFailure);
            assertSame(unexpected, PhoneAgentHostHandoff.finishFailure(false, CompletableFuture.completedFuture(null), activeReadFailure, null));
        }
    }

    @Test public void activeOrStoppedRuntimeErrorsAndCleanupFailuresRemainVisibleAfterExit() throws Exception {
        CompletableFuture<Void> proven = CompletableFuture.completedFuture(null);
        for (Throwable error : new Throwable[] { new IOException("actual read failure"), new IllegalStateException("event parsing failed"), new IOException("read interrupted") }) {
            // An event/cleanup exception with the same wording is not a marked stdout closure.
            assertSame(error, PhoneAgentHostHandoff.finishFailure(true, proven, error, null));
        }
        Throwable pipeClose = readFailure(true, new IOException("read interrupted"));
        for (String message : new String[] { "actions.close failed", "owned process cleanup failed" }) {
            IllegalStateException cleanup = new IllegalStateException(message);
            assertSame(cleanup, PhoneAgentHostHandoff.finishFailure(true, proven, pipeClose, cleanup));
        }
        IOException unknownReadError = new IOException("actual read failure");
        assertSame(unknownReadError, readFailure(true, unknownReadError));
    }

    @Test public void aCleanExplicitStopCanSetStoppedButUnexpectedEofOrMissingExitProofCannot() {
        assertNull(PhoneAgentHostHandoff.finishFailure(true, CompletableFuture.completedFuture(null), null, null));
        assertNotNull(PhoneAgentHostHandoff.finishFailure(false, CompletableFuture.completedFuture(null), null, null));
        assertNotNull(PhoneAgentHostHandoff.finishFailure(true, new CompletableFuture<>(), null, null));
        CompletableFuture<Void> failedExit = new CompletableFuture<>();
        failedExit.completeExceptionally(new TimeoutException("exit timed out"));
        assertNotNull(PhoneAgentHostHandoff.finishFailure(true, failedExit, null, null));
    }

    @Test public void readerCloseFailureSuppressedOnAnExpectedPipeClosureStillFailsTheStop() throws Exception {
        try (BufferedReader reader = new BufferedReader(new Reader() {
            @Override public int read(char[] buffer, int offset, int count) throws IOException { throw new IOException("read interrupted"); }
            @Override public void close() throws IOException { throw new IOException("reader.close failed"); }
        })) {
            PhoneAgentHostHandoff.readLine(reader, () -> true);
            fail("reader must fail");
        } catch (IOException error) {
            assertEquals(1, error.getSuppressed().length);
            assertEquals("reader.close failed", error.getSuppressed()[0].getMessage());
            assertSame(error, PhoneAgentHostHandoff.finishFailure(true, CompletableFuture.completedFuture(null), error, null));
        }
    }

    private static Throwable readFailure(boolean stopping, IOException failure) throws Exception {
        BufferedReader reader = new BufferedReader(new Reader() {
            @Override public int read(char[] buffer, int offset, int count) throws IOException { throw failure; }
            @Override public void close() {}
        });
        try { PhoneAgentHostHandoff.readLine(reader, () -> stopping); fail("reader must fail"); return null; }
        catch (IOException error) { return error; }
    }

    private static Throwable failureOf(CompletableFuture<Void> future) {
        assertTrue(future.isDone());
        try { future.join(); fail("expected failure"); return null; }
        catch (CompletionException error) { return error.getCause(); }
    }
}
