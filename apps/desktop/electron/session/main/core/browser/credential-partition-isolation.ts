import { app, webContents, type WebContents } from 'electron';
import type { CredentialUseBinding } from './credential-use-contract';
import { assertCredentialWebsite } from './credential-website';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { copyCredentialBinding, credentialBindingMatches } from './credential-binding';
import {
  markCredentialHandoffCandidate, privateCredentialSurface, publishCredentialHandoffCandidate,
  restrictCredentialPartition, type PrivateCredentialSurface,
} from './credential-isolation-registry';

/**
 * Host-only prototype for B's physical partition boundary. It RETIRES the old Agent renderer;
 * there is no observation pause/resume or attempt to restore its old tasks/observers.
 * Real availability still requires B-2/B-3, artifact custodians and full-path acceptance.
 */
export class CredentialPartitionIsolation {
  private readonly surface: PrivateCredentialSurface;
  private readonly controller = new AbortController();
  private readonly releaseRestriction: () => void;
  private readonly nativeSession: WebContents['session'];
  private readonly registration: object;
  private phase: 'preparing' | 'isolated' | 'cleaning' | 'publishing' | 'published_pending' | 'handed_back' | 'fault' = 'preparing';
  private candidate: WebContents | undefined;
  private constructingCandidate = false;
  private candidateCreations = 0;

  private constructor(private readonly binding: CredentialUseBinding, private readonly source: WebContents) {
    this.surface = privateCredentialSurface(binding.loginSurfaceId, binding.loginSurfaceEpoch);
    if (this.surface.browserId !== binding.browserId || source.isDestroyed() || this.surface.contents.isDestroyed() || source === this.surface.contents
      || source.session !== this.surface.contents.session
      || !browserWebContentsRegistry.isRegistered(binding.browserId, this.surface.partition)
      || !browserWebContentsRegistry.browsersOfSession(binding.sessionId)
        .some(page => page.browserId === binding.browserId && page.webContents === source)) {
      throw new Error('credential_source_unavailable');
    }
    this.nativeSession = source.session;
    const registration = browserWebContentsRegistry.registrationIdentity(binding.browserId);
    if (!registration) throw new Error('credential_source_unavailable');
    this.registration = registration;
    this.releaseRestriction = restrictCredentialPartition(this.surface.partition, this.nativeSession, this);
    app.on('web-contents-created', this.created);
    this.surface.contents.once('destroyed', this.privateDestroyed);
  }

  /** Resolves only after actual native destruction, with no other live same-session page. */
  static async prepare(binding: CredentialUseBinding, source: WebContents): Promise<CredentialPartitionIsolation> {
    const fixed = copyCredentialBinding(binding);
    const boundary = new CredentialPartitionIsolation(fixed, source);
    try {
      boundary.checkPages(true);
      await boundary.retireSource();
      if (!source.isDestroyed()) throw new Error('credential_source_retirement_unconfirmed');
      boundary.checkPages(false);
      if (boundary.phase !== 'preparing') throw new Error('credential_isolation_unavailable');
      boundary.phase = 'isolated';
      return boundary;
    } catch (error) {
      // Preparation has never been ready, so no capability/secret may have been released.
      boundary.invalidate(); boundary.releaseRestriction();
      throw error;
    }
  }

  get signal(): AbortSignal { return this.controller.signal; }

  /** Lifecycle guard also accepts the already-published replacement; fill readiness never does. */
  assertLifecycleCurrent(binding: CredentialUseBinding): void {
    if (this.phase !== 'handed_back') { this.assertPhysical(binding); return; }
    if (!credentialBindingMatches(this.binding, binding)
      || this.signal.aborted || !this.candidate || this.candidate.isDestroyed()
      || browserWebContentsRegistry.registrationIdentity(binding.browserId) !== this.registration
      || !browserWebContentsRegistry.isRegisteredForSession(binding.browserId, binding.sessionId, this.surface.partition)
      || browserWebContentsRegistry.browserIdFor(this.candidate.id) !== binding.browserId) {
      throw new Error('credential_handoff_target_unavailable');
    }
  }

  assertCurrent(binding: CredentialUseBinding): void {
    this.assertPhysical(binding);
    if (this.phase === 'publishing' || this.phase === 'published_pending') throw new Error('credential_fill_finished');
  }

  private assertPhysical(binding: CredentialUseBinding): void {
    if (!credentialBindingMatches(this.binding, binding)) {
      throw new Error('credential_isolation_unavailable');
    }
    try {
      if (this.phase === 'fault' || this.phase === 'handed_back' || this.phase === 'preparing'
        || !this.source.isDestroyed()
        || browserWebContentsRegistry.registrationIdentity(binding.browserId) !== this.registration
        || !browserWebContentsRegistry.isRegisteredForSession(binding.browserId, binding.sessionId, this.surface.partition)) {
        throw new Error('credential_isolation_unavailable');
      }
      this.checkPages(false);
      if (this.phase === 'isolated' && this.surface.contents.isDestroyed()) throw new Error('credential_private_surface_unavailable');
      if (!this.surface.contents.isDestroyed() && this.surface.contents.debugger.isAttached()) throw new Error('credential_private_debugger_attached');
    } catch (error) { this.invalidate(); throw error; }
  }

  /** Only the fixed cleanup coordinator calls this after revoking the fill/submit lease. */
  beginCleanup(): void {
    if (this.phase === 'isolated') this.phase = 'cleaning';
  }

  /** Construct a fresh, initially unpublished destination while partition admission remains closed. */
  prepareCandidate<T extends { webContents: WebContents }>(create: () => T): T {
    this.assertCurrent(this.binding);
    if (this.phase !== 'cleaning' || !this.surface.contents.isDestroyed() || this.candidate || this.constructingCandidate) {
      throw new Error('credential_handoff_candidate_unavailable');
    }
    this.constructingCandidate = true; this.candidateCreations = 0;
    try {
      const result = create();
      // The native creation event mutates these fields while create() is running.
      const prepared = this.preparedCandidate();
      if (prepared.count !== 1 || !prepared.contents || result.webContents !== prepared.contents || prepared.contents.isDestroyed()) {
        throw new Error('credential_handoff_candidate_unavailable');
      }
      return result;
    } catch (error) { this.invalidate(); throw error; }
    finally { this.constructingCandidate = false; }
  }

  /**
   * B-3 calls only after its own cleanup/audit/fresh checks and the new page's actual load.
   * Publish is synchronous native adoption of that PREPARED page; Agent admission stays CLOSED.
   * This method is not an IPC, person action, proof verifier or second handback authority.
   */
  publishCandidate(contents: WebContents, publish: () => void): void {
    this.assertCurrent(this.binding);
    if (this.phase !== 'cleaning' || contents !== this.candidate || contents.isDestroyed()
      || !this.surface.contents.isDestroyed() || contents.debugger.isAttached()) throw new Error('credential_handoff_candidate_unavailable');
    try {
      assertCredentialWebsite(contents.getURL(), this.binding.origin);
      this.phase = 'publishing';
      const result: unknown = publish();
      if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
        void Promise.resolve(result).catch(() => {});
        throw new Error('credential_handoff_publish_async');
      }
      if (this.signal.aborted || contents.isDestroyed() || browserWebContentsRegistry.browserIdFor(contents.id) !== this.binding.browserId) {
        throw new Error('credential_handoff_publish_unconfirmed');
      }
      this.phase = 'published_pending';
    } catch (error) {
      markCredentialHandoffCandidate(contents); this.invalidate();
      throw error;
    }
  }

  /** B-3's final fresh proof/current check and this callback have no intervening await.
   * This switch performs no navigation, events, callbacks or other externally controlled work.
   */
  confirmCandidate(contents: WebContents): void {
    this.assertLifecycleCurrent(this.binding);
    if (this.phase !== 'published_pending' || contents !== this.candidate || contents.isDestroyed()
      || browserWebContentsRegistry.browserIdFor(contents.id) !== this.binding.browserId
      || contents.debugger.isAttached()) throw new Error('credential_handoff_confirmation_unavailable');
    assertCredentialWebsite(contents.getURL(), this.binding.origin);
    publishCredentialHandoffCandidate(contents);
    this.phase = 'handed_back'; this.unwire(); this.releaseRestriction();
  }

  /** Synchronous fail-close before waiting for native destruction. Confirmed handbacks are final. */
  retractCandidate(contents: WebContents): void {
    if (contents !== this.candidate || this.phase === 'handed_back') return;
    markCredentialHandoffCandidate(contents); this.invalidate();
  }

  allowsPublication(contents: WebContents): boolean { return this.phase === 'publishing' && contents === this.candidate; }

  /** A fault never reopens partition admission, even after a later success or destroyed page. */
  invalidate(): void {
    if (this.phase === 'handed_back') return;
    this.phase = 'fault'; this.controller.abort(new Error('credential_isolation_unavailable')); this.unwire();
  }

  private readonly created = (_event: unknown, contents: WebContents) => {
    if (contents.session !== this.nativeSession) return;
    if (this.constructingCandidate && this.candidateCreations++ === 0) {
      this.candidate = contents; markCredentialHandoffCandidate(contents);
    } else this.invalidate();
  };
  private readonly privateDestroyed = () => { if (this.phase !== 'cleaning' && this.phase !== 'fault') this.invalidate(); };

  private checkPages(allowSource: boolean): void {
    const unexpected = webContents.getAllWebContents().some(contents => !contents.isDestroyed()
      && contents.session === this.nativeSession && contents !== this.surface.contents && contents !== this.candidate
      && !(allowSource && contents === this.source));
    if (unexpected) throw new Error('credential_partition_has_other_pages');
  }

  private preparedCandidate(): { count: number; contents: WebContents | undefined } {
    return { count: this.candidateCreations, contents: this.candidate };
  }

  private retireSource(): Promise<void> {
    if (this.source.isDestroyed()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.source.removeListener('destroyed', destroyed); reject(new Error('credential_source_retirement_unconfirmed')); }, 5_000);
      const destroyed = () => { clearTimeout(timer); resolve(); };
      this.source.once('destroyed', destroyed);
      try { this.source.close({ waitForBeforeUnload: false }); }
      catch { clearTimeout(timer); this.source.removeListener('destroyed', destroyed); reject(new Error('credential_source_retirement_unconfirmed')); }
    });
  }
  private unwire(): void {
    app.removeListener('web-contents-created', this.created);
    this.surface.contents.removeListener('destroyed', this.privateDestroyed);
  }
}
