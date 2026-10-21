/**
 * Per-project runtime state directory kept inside the repository.
 *
 * Holds state the product writes on the user's behalf but that never belongs in
 * their tree — today that is uploaded images and saved attachments. It is excluded
 * locally via `.git/info/exclude` rather than a tracked `.gitignore`.
 */
export const PROJECT_STATE_DIR_NAME = '.gugu';
