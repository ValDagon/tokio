import { api } from 'sdk';
import { ACCESS_DENIED_MESSAGE } from '../lib/auth.js';
import { checkAccess } from './onboarding.js';
import { routeCallback } from './router.js';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface Chat {
  id: number;
  type?: string;
}

export interface Message {
  message_id?: number;
  chat: Chat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  /** Inline-клавиатура сообщения: нужна, чтобы убрать из неё уже решённые строки. */
  reply_markup?: {
    inline_keyboard?: Array<
      Array<{ text: string; callback_data?: string; url?: string; web_app?: { url: string } }>
    >;
  };
}

export interface CallbackQuery {
  id: string;
  from?: TelegramUser;
  message?: Message;
  data?: string;
  chat_instance?: string;
}

export interface HandlerContext {
  update?: unknown;
  initData?: string | null;
}

/**
 * Edge-хэндлер для callback_query апдейтов платформы tgcloud.
 * Защищён fail-closed гейтом доступа checkAccess и делегирует в общую маршрутизацию routeCallback.
 */
export default async function handleCallbackQuery(
  query: CallbackQuery,
  _ctx: HandlerContext = {},
): Promise<void> {
  const userId = query.from?.id;
  if (!userId) return;

  const access = await checkAccess(userId, { kind: 'callback' });
  if (!access.allowed) {
    try {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: access.reply || ACCESS_DENIED_MESSAGE,
        show_alert: access.alert === true,
      });
    } catch {
      // ignore
    }
    return;
  }

  await routeCallback(query);
}

export { handleCallbackQuery };
