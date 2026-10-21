package app.gugu.chat;

/** JSON uses Integer for small offsets and Long for dates; Capacitor getLong only accepts Long. */
final class PhoneReadNumbers {
    // MediaStore stores whole seconds: both >= after and < before need a ceiling boundary.
    static long mediaSeconds(long milliseconds) { return milliseconds / 1000 + (milliseconds % 1000 == 0 ? 0 : 1); }

    static Long optional(Object value, String name) {
        if (value == null) return null;
        if (!(value instanceof Number)) throw new IllegalArgumentException(name + " 必须是非负整数");
        double number = ((Number) value).doubleValue();
        if (!Double.isFinite(number) || number < 0 || number > 9007199254740991d || Math.floor(number) != number)
            throw new IllegalArgumentException(name + " 必须是非负安全整数");
        return ((Number) value).longValue();
    }
}
