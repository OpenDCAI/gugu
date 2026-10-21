type ImportMetaWithEnv = ImportMeta & { env?: { VITE_BUILD?: string } };

const env = (import.meta as ImportMetaWithEnv).env;
const isCanary = env?.VITE_BUILD === 'canary';

// 真正的包身份(appId `com.gugu.app`,Mac 是 `nextmind.gugu`(#7394) / productName「咕咕」/ 产物名)在仓根
// electron-builder.cjs 里,不在这儿。这个文件只剩四个还有人用的常量;原先并排放着的
// APP_ID / USER_DATA_DIR_NAME / ARTIFACT_PREFIX / R2_BASE_URL 一个引用都没有,
// 已删除,留着只会让人误以为它们说了算。
export const PRODUCT_NAME = isCanary ? 'gugu Canary' : 'gugu';
export const APP_NAME_LOWER = isCanary ? 'gugu-canary' : 'gugu';
export const UPDATE_CHANNEL = isCanary ? 'v1-canary' : 'v1-stable';
export const IS_CANARY = isCanary;
