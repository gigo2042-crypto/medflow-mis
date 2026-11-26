// © 2026 Tony Genenncher. Все права защищены. Исходный код доступен только для просмотра — см. LICENSE.
// Версия приложения для метрик и отчётов об ошибках: MEDFLOW_VERSION (CI) или версия из package.json.
import pkg from '../../package.json'

export const APP_VERSION: string = process.env.MEDFLOW_VERSION || pkg.version
