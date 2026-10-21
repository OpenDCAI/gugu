export default {
  "actions": {
    "copiedAgentId": "Agent ID copied",
    "copiedGuguNumber": "Gugu ID copied",
    "copiedLink": "Link copied",
    "copy": "Copy",
    "copyFailed": "Could not copy"
  },
  "cloudComputer": {
    "reason": {
      "plan_required": "Gugu comes with Plus and above.",
      "credits_exhausted": "You're out of credits.",
      "membership_expired": "Your membership has expired, so its cloud resources are paused. Renew, or move it back to your own computer.",
      "timeout": "It didn't connect within two minutes.",
      "network": "Can't reach Gugu service. Check your network.",
      "signed_out": "You've been signed out. Sign in again and retry.",
      "gone": "your Gugu has been closed.",
      "failed": "Something went wrong on Gugu's side."
    }
  },
  "agentStatus": {
    "running": "Running",
    "parked": "Running in background",
    "needsApproval": "Needs your approval",
    "needsAnswer": "Needs your answer",
    "needsPlanReview": "Needs your plan review",
    "needsAction": "Needs your action",
    "error": "Error",
    "done": "Done",
    "idle": "Idle",
    "online": "Online",
    "offline": "Offline",
    "removed": "Removed",
    "pending": "Confirming",
    "none": "Status unavailable"
  },
  "agentShare": {
    "guguNumber": "Gugu ID",
    "close": "Close",
    "dialog": "Share {{name}}",
    "generatePoster": "Create contact poster",
    "inviteLink": "Invite link",
    "numberUnassigned": "Not assigned",
    "copied": "Copied",
    "copyRow": "Copy {{label}}",
    "makePublic": "Make public",
    "makingPublic": "Making public…",
    "makePublicHint": "Make it public to get a Gugu ID and invite link.",
    "makePublicFailed": "Could not make the agent public",
    "title": "Share Agent"
  },
  "brand": {
    "documentTitle": "Gugu"
  },
  "dialog": {
    "close": "Close dialog",
    "label": "Dialog"
  },
  "errors": {
    "offline": "Could not connect. Check your network and try again.",
    "operationFailed": "Something went wrong. Try again.",
    "permissionDenied": "You do not have permission to do this."
  },
  "locale": {
    "enUS": "English",
    "label": "Language",
    "system": "System default",
    "zhCN": "简体中文"
  },
  "relativeTime": {
    "daysAgo": "{{count}} days ago",
    "daysAgo_one": "{{count}} day ago",
    "daysAgo_other": "{{count}} days ago",
    "hoursAgo": "{{count}} hours ago",
    "hoursAgo_one": "{{count}} hour ago",
    "hoursAgo_other": "{{count}} hours ago",
    "justNow": "now",
    "minutesAgo": "{{count}} minutes ago",
    "minutesAgo_one": "{{count}} minute ago",
    "minutesAgo_other": "{{count}} minutes ago"
  },
  "toast": {
    "dismiss": "Dismiss"
  },
  "tabs": {
    "pending": "{{label}}, {{count}} pending",
    "pending_one": "{{label}}, {{count}} pending",
    "pending_other": "{{label}}, {{count}} pending"
  }
} as const;
