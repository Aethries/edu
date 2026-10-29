export function formatNumber(
    value: number,
    options?: Intl.NumberFormatOptions,
    locale = "en-US",
) {
    return new Intl.NumberFormat(locale, options).format(value);
}
