export const forbiddenPublishedLifecycleScripts = ['preinstall', 'install', 'postinstall']

export function verifyPublishedLifecycleScripts(pkg) {
  const failures = []
  for (const lifecycle of forbiddenPublishedLifecycleScripts) {
    if (Object.hasOwn(pkg.scripts ?? {}, lifecycle)) {
      failures.push(`published manifest must not run development lifecycle script: ${lifecycle}`)
    }
  }
  return failures
}
