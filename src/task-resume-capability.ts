export const TASK_RESUME_PROTOCOL = "opencode-ssh-task-resume-v1" as const

export type TaskResumeCapability = typeof TASK_RESUME_PROTOCOL

export function isTaskResumeSupported(
  reportedOpenCodeVersion: string,
  loaderRuntimeVersion: string,
  callableSessionLookupObservedInLoaderProcess: boolean
): boolean {
  return (
    callableSessionLookupObservedInLoaderProcess &&
    reportedOpenCodeVersion === loaderRuntimeVersion
  )
}
