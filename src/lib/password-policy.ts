export const adminPasswordPattern = "(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{9,256}";
export const adminPasswordHelp = "密码须至少 9 位，只包含英文字母和数字，且两者都要有";
export function validAdminPassword(password: string) {
  return new RegExp(`^${adminPasswordPattern}$`).test(password);
}
