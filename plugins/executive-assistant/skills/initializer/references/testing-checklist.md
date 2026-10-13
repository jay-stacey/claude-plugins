# Testing Checklist - initializer

Developer-facing verification steps for this skill. Not needed at runtime.

- [ ] All questions display correctly
- [ ] Multi-select questions work
- [ ] Free-text input handles special characters
- [ ] Profile markdown generates correctly
- [ ] Config JSON is valid
- [ ] Error handling works for invalid input
- [ ] Setup can be re-run to update profile
- [ ] Focus profile is asked only after an explicit yes
- [ ] Focus profile writes `## Focus profile` to `{vault}/assistant/profile.md`
- [ ] Re-running replaces only that section and keeps the rest of the file
- [ ] With no vault set, the section goes into `user-profile.md` instead
