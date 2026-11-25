### Where and how
- `git fetch origin main`, then `git checkout --detach origin/main`: QA runs on what is merged.
- Start your own server, if the change needs one, the way `CLAUDE.md` or `README.md` says, on the port your plan notes name (common playbook, "Servers and parallel sessions").
- A change with a UI: test it at **1280 and 390** wide. On the phone layout use real touch events and WebKit, not mouse events in Chromium.
- A change without a UI (a command, an API route, a script): run it as its caller does, with the inputs the issue names, and read the exit code and the output.

### Findings
Linear observations, as the common playbook says, with the issue id in the text; one summary comment on the issue. A P0 or P1 also goes to your parent at once.

### Browser rules
- All browsing through gstack's `/browse`.
- Your own local server only, unless your parent names another address.
- Never sign in anywhere and never type into a third-party site; an account the test needs is signed in by the owner.
