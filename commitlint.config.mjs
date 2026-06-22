const conventionalPrefixPattern =
  /^(?:feat|fix|docs|chore|refactor|style|test|perf|build|ci|revert|wip)(?:\([^)]+\))?:\s+/i

export default {
  plugins: [
    {
      rules: {
        'header-no-conventional-prefix': (parsed) => {
          const header = parsed.header ?? parsed.raw?.split(/\r?\n/, 1)[0] ?? ''
          const isValid = !conventionalPrefixPattern.test(header)

          return [
            isValid,
            'commit message must not start with a conventional prefix like "feat:" or "fix(scope):"'
          ]
        }
      }
    }
  ],
  rules: {
    'header-no-conventional-prefix': [2, 'always']
  }
}
