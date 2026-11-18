// The artifakto mod's session state (docs/phase-8-threads-spec.md section 9): display data for its panes only. Every
// plugin can read $.state, so nothing secret goes here: the export and the credentials stay in the hooks module and
// in $.store.

export type ArtifaktoHandoff = {
  phase: 'drafting' | 'review' | 'publishing' | 'done'
  /** `Add to "<title>" on <host>` or `Start "<title>" on <host>`. */
  heading: string
  readers: string[]
  as: string | null
  report: string[]
  exportNote: string | null
  hasExport: boolean
  brief: string | null
  /** Something that failed, drawn in the error colour. */
  message: string | null
  /** Guidance, not a failure (no brief was drafted): drawn dim. */
  notice: string | null
  url: string | null
}

export type ArtifaktoConnect = {
  phase: 'waiting' | 'connecting' | 'done'
  link: string
  pairing: string
  /** The host the sign-in is on, as the person pasted it: the page must be on it. */
  host: string
  message: string | null
}

/** /artifakto-login's pane (docs/phase-9-chatgpt-spec.md section 13): the same steps as /thread-connect, for the sign-in the CLI and the mod share; once done, `message` names the account. */
export type ArtifaktoLogin = {
  phase: 'waiting' | 'connecting' | 'done'
  link: string
  pairing: string
  /** The host the sign-in is on: the page must be on it. */
  host: string
  message: string | null
}

declare module 'claude-code' {
  interface PluginState {
    artifakto: { handoff: ArtifaktoHandoff | null; connect: ArtifaktoConnect | null; login: ArtifaktoLogin | null }
  }
}
