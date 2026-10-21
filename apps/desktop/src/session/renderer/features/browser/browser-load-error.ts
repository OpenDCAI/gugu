import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import type { BrowserLoadError } from '@shared/browser';

export interface BrowserLoadErrorPresentation {
  heading: string;
  detail: string;
}

const ERROR_CONSTANT_PATTERN = /^(?:net::)?(err_[a-z0-9_]+)$/i;

// Subset of Chromium net error codes we map to a tailored message. Electron
// usually hands us the constant directly in `description`, but older paths only
// provide the numeric code, so we resolve both.
const ERROR_CODE_CONSTANTS: Record<number, string> = {
  [-7]: 'ERR_TIMED_OUT',
  [-21]: 'ERR_NETWORK_CHANGED',
  [-100]: 'ERR_CONNECTION_CLOSED',
  [-101]: 'ERR_CONNECTION_RESET',
  [-102]: 'ERR_CONNECTION_REFUSED',
  [-104]: 'ERR_CONNECTION_FAILED',
  [-105]: 'ERR_NAME_NOT_RESOLVED',
  [-106]: 'ERR_INTERNET_DISCONNECTED',
  [-107]: 'ERR_SSL_PROTOCOL_ERROR',
  [-109]: 'ERR_ADDRESS_UNREACHABLE',
  [-118]: 'ERR_CONNECTION_TIMED_OUT',
  [-137]: 'ERR_NAME_RESOLUTION_FAILED',
  [-200]: 'ERR_CERT_COMMON_NAME_INVALID',
  [-201]: 'ERR_CERT_DATE_INVALID',
  [-202]: 'ERR_CERT_AUTHORITY_INVALID',
  [-300]: 'ERR_INVALID_URL',
  [-501]: 'ERR_INSECURE_RESPONSE',
};

export function browserLoadErrorConstant(error: BrowserLoadError): string | null {
  const match = error.description.trim().match(ERROR_CONSTANT_PATTERN);
  if (match) return match[1].toUpperCase();
  if (error.code !== undefined && error.code in ERROR_CODE_CONSTANTS) {
    return ERROR_CODE_CONSTANTS[error.code];
  }
  return null;
}

// The Chromium constant and the numeric code are raw diagnostics and stay
// verbatim; only the "Error <code>" shell around a bare number is localized.
export function browserLoadErrorCode(
  error: BrowserLoadError,
  translate: ProjectsTranslate
): string | null {
  const constant = browserLoadErrorConstant(error);
  if (constant) return constant;
  if (error.code === undefined) return null;
  return translate('browser.loadError.code', { code: error.code });
}

export function describeBrowserLoadError(
  error: BrowserLoadError,
  url: string,
  translate: ProjectsTranslate
): BrowserLoadErrorPresentation {
  const host = hostLabel(error.url ?? url, translate);
  const constant = browserLoadErrorConstant(error);
  const unreachable = translate('browser.loadError.unreachable');

  switch (constant) {
    case 'ERR_NAME_NOT_RESOLVED':
    case 'ERR_NAME_RESOLUTION_FAILED':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.nameNotResolved', { host }),
      };
    case 'ERR_CONNECTION_REFUSED':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.connectionRefused', { host }),
      };
    case 'ERR_TIMED_OUT':
    case 'ERR_CONNECTION_TIMED_OUT':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.timedOut', { host }),
      };
    case 'ERR_CONNECTION_RESET':
    case 'ERR_CONNECTION_CLOSED':
    case 'ERR_CONNECTION_FAILED':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.connectionInterrupted', { host }),
      };
    case 'ERR_ADDRESS_UNREACHABLE':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.addressUnreachable', { host }),
      };
    case 'ERR_INTERNET_DISCONNECTED':
      return {
        heading: translate('browser.loadError.noInternetHeading'),
        detail: translate('browser.loadError.noInternetDetail'),
      };
    case 'ERR_NETWORK_CHANGED':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.networkChanged'),
      };
    case 'ERR_SSL_PROTOCOL_ERROR':
    case 'ERR_INSECURE_RESPONSE':
      return {
        heading: translate('browser.loadError.insecureHeading'),
        detail: translate('browser.loadError.insecureDetail', { host }),
      };
    case 'ERR_CERT_COMMON_NAME_INVALID':
    case 'ERR_CERT_DATE_INVALID':
    case 'ERR_CERT_AUTHORITY_INVALID':
      return {
        heading: translate('browser.loadError.certHeading'),
        detail: translate('browser.loadError.certDetail', { host }),
      };
    case 'ERR_INVALID_URL':
      return {
        heading: unreachable,
        detail: translate('browser.loadError.invalidUrl'),
      };
    default: {
      // An unknown Chromium description is raw diagnostic text: shown verbatim
      // (only sentence-cased), never rewritten into a localized shell.
      const description = error.description.trim();
      const isConstant = ERROR_CONSTANT_PATTERN.test(description);
      const detail =
        description.length > 0 && !isConstant
          ? sentence(description)
          : translate('browser.loadError.genericDetail', { host });
      return {
        heading: unreachable,
        detail,
      };
    }
  }
}

/** The host is raw URL data; only the "no usable URL" stand-in is localized. */
export function hostLabel(url: string, translate: ProjectsTranslate): string {
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed === 'about:blank') {
    return translate('browser.loadError.fallbackHost');
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || trimmed;
  } catch {
    return trimmed;
  }
}

function sentence(value: string): string {
  const text = value.charAt(0).toUpperCase() + value.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
