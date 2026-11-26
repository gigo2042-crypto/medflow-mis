// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
