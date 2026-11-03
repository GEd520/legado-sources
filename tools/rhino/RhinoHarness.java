import org.mozilla.javascript.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;

/**
 * RhinoHarness —— 在真实 Rhino 引擎里复刻 Legado 的规则执行环境
 * ------------------------------------------------------------------
 * 复刻要点（均对照 Legado_Max 源码）：
 *   1. jsLib 先求值，此时作用域里没有 java / source
 *   2. 规则求值时 bindings 里放 java/source/cache，并 chainTo(jsLib 作用域)
 *   3. java 是 JsExtensions（宿主 API），source 是 BaseSource
 *
 * 目的：在把书源发给任何用户之前，就确认它「不会一加载就崩」。
 */
public class RhinoHarness {
    static String DIR = ".";

    static String read(String p) {
        try { return new String(Files.readAllBytes(Paths.get(p)), "UTF-8"); }
        catch (Exception e) { return ""; }
    }

    public static void main(String[] a) throws Exception {
        DIR = a[0];
        // 强制 UTF-8 输出，避免 Windows 控制台代码页把中文打成问号
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8"));

        String jsLib = read(Paths.get(DIR, "jsLib.txt").toString());
        String rule  = read(Paths.get(DIR, "rule.js").toString());

        Context cx = Context.enter();
        cx.setLanguageVersion(Context.VERSION_ES6);
        cx.setOptimizationLevel(-1);          // 解释模式，与 Android 上更接近
        try {
            ScriptableObject shared = cx.initStandardObjects();   // ≈ SharedJsScope

            /* ---------- 阶段 1：jsLib（无 java/source）---------- */
            try {
                cx.evaluateString(shared, jsLib, "jsLib", 1, null);
                System.out.println("[JSLIB_OK]");
            } catch (Throwable e) {
                System.out.println("[JSLIB_FAIL] " + e.getClass().getSimpleName() + ": " + e.getMessage());
                return;
            }

            /* ---------- 阶段 2：规则作用域 ---------- */
            ScriptableObject bindings = (ScriptableObject) cx.newObject(shared);
            bindings.setPrototype(shared);

            Source src = new Source();
            bindings.put("java",   bindings, new JsExt());
            bindings.put("source", bindings, src);
            bindings.put("cache",  bindings, src.cache);
            bindings.put("book",   bindings, new Book());

            /* ---------- 阶段 3：执行规则 ---------- */
            try {
                Object r = cx.evaluateString(bindings, rule, "rule", 1, null);
                System.out.println("[RULE_OK] " + Context.toString(r));
            } catch (Throwable e) {
                System.out.println("[RULE_FAIL] " + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        } finally { Context.exit(); }
    }

    /* ================= 宿主 API（JsExtensions 子集） ================= */
    public static class JsExt {
        String ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36";

        public String androidId() { return read(Paths.get(DIR, "did.txt").toString()).trim(); }
        public String getWebViewUA() { return ua; }
        public String log(String s) { System.out.println("[log] " + s); return s; }
        public String longToast(String s) { System.out.println("[toast] " + s); return ""; }
        public String toast(String s) { System.out.println("[toast] " + s); return ""; }
        public String md5Encode(String s) { return md5(s); }
        public String md5Encode16(String s) { String d = md5(s); return d.substring(8, 24); }

        public String base64Encode(String s) {
            return Base64.getEncoder().encodeToString(s.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        public String base64Decode(String s) {
            try { return new String(Base64.getDecoder().decode(s), "UTF-8"); } catch (Exception e) { return ""; }
        }
        public byte[] hexDecodeToByteArray(String h) {
            int n = h.length() / 2; byte[] r = new byte[n];
            for (int i = 0; i < n; i++) r[i] = (byte) Integer.parseInt(h.substring(i * 2, i * 2 + 2), 16);
            return r;
        }

        public Sym createSymmetricCrypto(String t, byte[] k, byte[] iv) { return new Sym(k, iv); }

        /** 原书源 getUrl() 用：AES 解密 variableComment 再 eval */
        public String aesBase64DecodeToString(String data, String key, String mode, String iv) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/ECB/PKCS5Padding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE,
                       new javax.crypto.spec.SecretKeySpec(key.getBytes("UTF-8"), "AES"));
                return new String(c.doFinal(Base64.getDecoder().decode(data)), "UTF-8");
            } catch (Exception e) { throw new RuntimeException("aes: " + e); }
        }

        public Resp get(String url, Object headers) {
            System.out.println("[get] " + url);
            if (url != null && url.contains("/k?")) {
                return new Resp(read(Paths.get(DIR, "resp.json").toString()), 200);
            }
            // 原作者的授权校验接口：给足期望值，模拟验签通过
            String K = "爱丽丝密钥";
            return new Resp("{\"data\":{\"key\":\"" + K + "\",\"msg\":\"\",\"state\":\"" + K + "\",\"v\":\"" + K + "\"},"
                          + "\"msg\":\"" + K + "\",\"key\":\"" + K + "\",\"state\":\"" + K + "\",\"code\":\"" + K + "\"}", 200);
        }
        public Resp get(String url) { return get(url, null); }

        public Object getElement(String s) { return null; }
        public void setContent(String s) { }
        public String encodeURI(String s) {
            try { return java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20"); } catch (Exception e) { return s; }
        }
        public String timeFormat(long t) { return String.valueOf(t); }
        public String randomUUID() { return UUID.randomUUID().toString(); }
        public void sleep(long ms) { }
        public String ajax(String u) { return ""; }

        static String md5(String s) {
            try {
                MessageDigest md = MessageDigest.getInstance("MD5");
                byte[] d = md.digest(s.getBytes("UTF-8"));
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                return sb.toString();
            } catch (Exception e) { return ""; }
        }
    }

    /* ================= 加解密 ================= */
    public static class Sym {
        byte[] k, iv;
        Sym(byte[] k, byte[] iv) { this.k = k; this.iv = iv; }
        public String decryptStr(String b64) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(k, "AES"),
                       new javax.crypto.spec.IvParameterSpec(iv));
                return new String(c.doFinal(Base64.getDecoder().decode(b64)), "UTF-8");
            } catch (Exception e) { throw new RuntimeException("decrypt: " + e); }
        }
    }

    public static class Resp {
        String b; int s;
        Resp(String b, int s) { this.b = b; this.s = s; }
        public int status() { return s; }
        public int statusCode() { return s; }
        public String body() { return b; }
        public String header(String n) { return ""; }
    }

    /* ================= BaseSource ================= */
    public static class Source {
        public String bookSourceUrl = "gate-test";
        public String searchUrl   = read(Paths.get(DIR, "searchUrl.txt").toString());
        public String jsLib       = read(Paths.get(DIR, "jsLib.txt").toString());
        public String exploreUrl  = read(Paths.get(DIR, "exploreUrl.txt").toString());
        public String variableComment = read(Paths.get(DIR, "vc.txt").toString());
        public Cache cache = mkCache();

        static Cache mkCache() {
            Cache c = new Cache();
            /* 模拟用户已在登录界面输入密钥：格式 [?, "base64"] */
            String loginKey = read(Paths.get(DIR, "login.txt").toString()).trim();
            if (!loginKey.isEmpty()) c.m.put("mykey", "[0,\"" + loginKey + "\"]");
            c.m.put("jk", "0");
            return c;
        }

        public Cache getCache() { return cache; }
        /* Rhino 会把 public 字段暴露给 JS；额外提供显式 getter 更稳 */
        public String getVariableComment() { return variableComment; }
        public String getSearchUrl() { return searchUrl; }
        public String getJsLib() { return jsLib; }
        public String getExploreUrl() { return exploreUrl; }
        /* 真机上 source.variable 是持久化的，这里用内存模拟，行为一致 */
        String variable = "{}";
        public String get(String k) { return cache.get(k); }
        public void put(String k, String v) { cache.put(k, v, 0); }
        public String getVariable() { return variable; }
        public void setVariable(String s) { variable = s; System.out.println("[setVariable] " + (s.length() > 160 ? s.substring(0,160)+"..." : s)); }
        public String getKey() { return bookSourceUrl; }
        public String getBookSourceUrl() { return bookSourceUrl; }
        public Map<String, String> getLoginInfoMap() {
            Map<String, String> m = new HashMap<>();
            m.put("源作者：", "辞晨");
            String cu = read(Paths.get(DIR, "customurl.txt").toString()).trim();
            if (!cu.isEmpty()) m.put("自定义url", cu);
            return m;
        }
    }

    public static class Cache {
        Map<String, String> m = new HashMap<>();
        public String get(String k) { return m.get(k); }
        public void put(String k, String v, int ttl) { m.put(k, v); }
        public void put(String k, String v) { m.put(k, v); }
        public void delete(String k) { m.remove(k); }
    }

    public static class Book {
        public String name = "测试书";
        public String author = "测试作者";
    }
}
