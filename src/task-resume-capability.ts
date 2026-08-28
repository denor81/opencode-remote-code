export const TASK_RESUME_PROTOCOL = "opencode-ssh-task-resume-v1" as const
export const TASK_RESUME_QUALIFIED_OPENCODE_VERSION = "1.18.18" as const

export type TaskResumeCapability = typeof TASK_RESUME_PROTOCOL

export function isTaskResumeQualified(
  reportedOpenCodeVersion: string,
  loaderRuntimeVersion: string,
  callableSessionLookupObservedInLoaderProcess: boolean
): boolean {
  return (
    callableSessionLookupObservedInLoaderProcess &&
    reportedOpenCodeVersion === loaderRuntimeVersion &&
    loaderRuntimeVersion === TASK_RESUME_QUALIFIED_OPENCODE_VERSION
  )
}
