### Linear in this repo
- Initiatives and projects carry the ids Linear shows on them (`I-<n>`, `P-<TEAM>-<n>`); `flow spawn` takes them as they are.
- Projects in one initiative share `main`: two projects that change the same files run one after the other.
- Each project session runs its own release under its plan's `release` setting, which the owner gives before its builds start; anything else on production is the owner's.
