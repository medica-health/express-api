// spring-api registers phone-only callers with a placeholder email that can never receive mail.
export const PHONE_PLACEHOLDER_DOMAIN = "phone.medicare.invalid";

export function isPhonePlaceholder(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${PHONE_PLACEHOLDER_DOMAIN}`);
}
