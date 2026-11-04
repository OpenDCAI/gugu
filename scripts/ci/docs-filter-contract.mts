import { isDeepStrictEqual } from 'node:util'

type Parsed = ReturnType<typeof JSON.parse>

// The only permitted conditional-test classifier: exact command, job and allowed environment.
// Output names alone cannot prove new source/spec files will actually execute.
export const DOCS_CLASSIFIER_RUN = [
  "build=true",
  "desktop_mac=true",
  "desktop_linux=true",
  "android=true",
  "tests=true",
  "# Preserve the approved exact same-repository integration full-validation window.",
  "if [ \"$EVENT_NAME\" = pull_request ] && {",
  "  [ \"$GITHUB_REPOSITORY\" != GUYI-AI/gugu ] ||",
  "    [ \"$PR_HEAD_REPOSITORY\" != \"$GITHUB_REPOSITORY\" ] ||",
  "    [ \"$PR_HEAD_REF\" != integration/beta-20261103 ]",
  "}; then",
  "  build=false",
  "  desktop_mac=false",
  "  desktop_linux=false",
  "  android=false",
  "  tests=false",
  "  changed=$(git diff --name-only HEAD^1 HEAD)",
  "  # An empty/unavailable change list must never silently exempt a source PR.",
  "  test -n \"$changed\"",
  "  while IFS= read -r file; do",
  "    [ -n \"$file\" ] || continue",
  "    case \"$file\" in",
  "      *.md|docs/*) continue ;;",
  "    esac",
  "    tests=true",
  "    build=true",
  "    # Mobile-only inputs still build the web renderer and Android, but no desktop app.",
  "    case \"$file\" in",
  "      apps/mobile/*|capacitor.config.ts|scripts/build/android-gradle-build.sh|scripts/build/phone-web-dir.mts)",
  "        android=true",
  "        continue",
  "        ;;",
  "    esac",
  "    desktop_linux=true",
  "    case \"$file\" in",
  "      .github/workflows/ci.yml|.github/actions/*|.node-version|.npmrc|package.json|*/package.json|pnpm-lock.yaml|pnpm-workspace.yaml|patches/*)",
  "        desktop_mac=true",
  "        android=true",
  "        ;;",
  "    esac",
  "    case \"$file\" in",
  "      apps/desktop/native/*|apps/desktop/session-tooling/node-deps/*)",
  "        desktop_mac=true",
  "        ;;",
  "    esac",
  "  done <<< \"$changed\"",
  "fi",
  "{",
  "  echo \"build=$build\"",
  "  echo \"desktop-mac=$desktop_mac\"",
  "  echo \"desktop-linux=$desktop_linux\"",
  "  echo \"android=$android\"",
  "  echo \"tests=$tests\"",
  "} >> \"$GITHUB_OUTPUT\"",
  "echo \"::notice title=ci-job-outputs::build=$build desktop-mac=$desktop_mac desktop-linux=$desktop_linux android=$android tests=$tests\"",
  "",
].join('\n')

const WORKFLOW_ENV = {
  "CI": true,
  "GUGU_SUPABASE_URL": "http://127.0.0.1:54321",
  "VITE_SUPABASE_URL": "http://127.0.0.1:54321",
  "GUGU_SUPABASE_ANON_KEY": "community-build-placeholder",
  "VITE_SUPABASE_ANON_KEY": "community-build-placeholder",
  "PLAYWRIGHT_IMAGE": "mcr.microsoft.com/playwright:v1.59.1-noble@sha256:b0ab6f3cb99aa7803adbc14d9027ec1785fc6e433b97e134e0f8fe61683b6b53"
}

const CHANGES_JOB = {
  "name": "Detect changed areas",
  "runs-on": "ubuntu-24.04",
  "timeout-minutes": 5,
  "outputs": {
    "build": "${{ steps.classify.outputs.build }}",
    "desktop-mac": "${{ steps.classify.outputs.desktop-mac }}",
    "desktop-linux": "${{ steps.classify.outputs.desktop-linux }}",
    "tests": "${{ steps.classify.outputs.tests }}",
    "android": "${{ steps.classify.outputs.android }}"
  },
  "steps": [
    {
      "if": "github.event_name == 'pull_request'",
      "uses": "actions/checkout@v4",
      "with": {
        "fetch-depth": 2,
        "sparse-checkout": ".github"
      }
    },
    {
      "id": "classify",
      "env": {
        "EVENT_NAME": "${{ github.event_name }}",
        "PR_HEAD_REPOSITORY": "${{ github.event.pull_request.head.repo.full_name }}",
        "PR_HEAD_REF": "${{ github.event.pull_request.head.ref }}"
      },
      "run": DOCS_CLASSIFIER_RUN
    }
  ]
}

export function hasVerifiedDocsClassifier(workflow: Parsed): boolean {
  return workflow?.defaults === undefined
    && isDeepStrictEqual(workflow.env, WORKFLOW_ENV)
    && isDeepStrictEqual(workflow.jobs?.changes, CHANGES_JOB)
}
