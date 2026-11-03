import org.mozilla.javascript.*;
import java.nio.file.*;

/** 完整模拟 Legado：jsLib 求值 → 规则作用域 chainTo → 调 GLIB/GEVAL */
public class RhinoHarness {
    static String DIR = ".";
    static String read(String p) throws Exception {
        return new String(Files.readAllBytes(Paths.get(p)), "UTF-8");
    }
    public static void main(String[] a) throws Exception {
        DIR = a[0];
        // 强制 UTF-8 输出，避免 Windows 控制台代码页把中文打成问号
        System.setOut(new java.io.PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8"));
        String jsLib = read(a[1]);
        String rule  = read(a[2]);
        Context cx = Context.enter();
        cx.setLanguageVersion(Context.VERSION_ES6);
        try {
            ScriptableObject shared = cx.initStandardObjects();
            // --- 阶段1：jsLib（Legado 在这里没有 java/source）---
            try {
                cx.evaluateString(shared, jsLib, "jsLib", 1, null);
                System.out.println("[JSLIB_OK] jsLib evaluated");
            } catch (Throwable e) {
                System.out.println("[JSLIB_FAIL] " + e.getMessage());
                return;
            }
            // --- 阶段2：规则作用域 ---
            ScriptableObject bindings = (ScriptableObject) cx.newObject(shared);
            bindings.setPrototype(shared);
            FakeSource src = new FakeSource();
            bindings.put("java",   bindings, new JsExtensions());
            bindings.put("source", bindings, src);
            bindings.put("cache",  bindings, src.cache);
            // --- 阶段3：跑规则 ---
            try {
                Object r = cx.evaluateString(bindings, rule, "rule", 1, null);
                System.out.println("[RULE_OK] " + Context.toString(r));
            } catch (Throwable e) {
                System.out.println("[RULE_FAIL] " + e.getMessage());
            }
        } finally { Context.exit(); }
    }

    public static class JsExtensions {
        public String androidId() { return "e2e-android-id-abcdef123456"; }
        public String md5Encode(String s) {
            try {
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
                byte[] d = md.digest(s.getBytes("UTF-8"));
                StringBuilder sb = new StringBuilder();
                for (byte b : d) sb.append(String.format("%02x", b));
                return sb.toString();
            } catch (Exception e) { return "err"; }
        }
        public String log(String s) { System.out.println("    [java.log] " + s); return s; }
        public byte[] hexDecodeToByteArray(String h) {
            int n = h.length() / 2; byte[] r = new byte[n];
            for (int i = 0; i < n; i++) r[i] = (byte) Integer.parseInt(h.substring(i*2, i*2+2), 16);
            return r;
        }
        public SymCrypto createSymmetricCrypto(String t, byte[] k, byte[] iv) { return new SymCrypto(k, iv); }
        /** 原书源 getUrl() 用：AES 解密 variableComment 再 eval */
        public String aesBase64DecodeToString(String data, String key, String mode, String iv) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/ECB/PKCS5Padding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE,
                       new javax.crypto.spec.SecretKeySpec(key.getBytes("UTF-8"), "AES"));
                return new String(c.doFinal(java.util.Base64.getDecoder().decode(data)), "UTF-8");
            } catch (Exception e) { throw new RuntimeException("aes: " + e); }
        }
        public String base64Encode(byte[] b) { return java.util.Base64.getEncoder().encodeToString(b); }
        public String md5Encode16(String s) { return md5Encode(s).substring(8, 24); }
        public String longToast(String s) { System.out.println("    [toast] " + s); return ""; }
        public String toast(String s) { return longToast(s); }
        public java.util.Map<String,Object> getResponse() { return new java.util.HashMap<>(); }
        public String ajax(String url) { return ""; }
        public Resp get(String url) { return get(url, null); }
        public String base64Decode(String s) { return new String(java.util.Base64.getDecoder().decode(s)); }
        public String encodeURI(String s) { return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8).replace("+","%20"); }
        public byte[] hexDecode(String h) { return hexDecodeToByteArray(h); }
        public Object getElement(String s) { return null; }
        public void setContent(String s) { }
        public String timeFormat(long t) { return String.valueOf(t); }
        public String randomUUID() { return java.util.UUID.randomUUID().toString(); }
        public String sleep(long ms) { return ""; }
        /** 假装发网络请求：返回预先写好的 /k 响应 */
        public Resp get(String url, Object headers) {
            System.out.println("    [java.get] " + url);
            if (url != null && url.contains("/k?")) {
                try { return new Resp(read(DIR + "/resp.json")); } catch (Exception e) { return new Resp("{}"); }
            }
            // 原作者的授权校验接口：所有叶子字段都给期望值，模拟「验签通过」
            return new Resp("{\"data\":{\"key\":\"爱丽丝密钥\",\"msg\":\"\",\"state\":\"爱丽丝密钥\",\"v\":\"爱丽丝密钥\",\"status\":\"爱丽丝密钥\",\"code\":\"爱丽丝密钥\"},\"msg\":\"爱丽丝密钥\",\"key\":\"爱丽丝密钥\",\"state\":\"爱丽丝密钥\"}");
        }
    }
    public static class SymCrypto {
        byte[] k, iv;
        SymCrypto(byte[] k, byte[] iv) { this.k = k; this.iv = iv; }
        public String decryptStr(String b64) {
            try {
                javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
                c.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(k, "AES"),
                       new javax.crypto.spec.IvParameterSpec(iv));
                return new String(c.doFinal(java.util.Base64.getDecoder().decode(b64)), "UTF-8");
            } catch (Exception e) { throw new RuntimeException("decrypt: " + e); }
        }
    }
    public static class Resp {
        String b; Resp(String b){ this.b = b; }
        public int status() { return 200; }
        public String body() { return b; }
    }
    public static class FakeCache {
        java.util.Map<String,String> m = new java.util.HashMap<>();
        public String get(String k){ return m.get(k); }
        public void put(String k, String v, int ttl){ m.put(k, v); }
        public void delete(String k){ m.remove(k); }
    }
    static String read0(String p){ try { return new String(Files.readAllBytes(Paths.get(p)),"UTF-8"); } catch(Exception e){ return ""; } }
    public static class FakeSource {
        public String bookSourceUrl = "gate-test";
        public String searchUrl = read0(DIR + "/searchUrl.txt");
        public String jsLib = read0(DIR + "/jsLib.txt");
        public String exploreUrl = read0(DIR + "/exploreUrl.txt");
        public String variableComment = read0(DIR + "/vc.txt");
        public String getVariable(){ return "{}"; }
        public java.util.Map<String,String> getLoginInfoMap(){ 
            java.util.Map<String,String> m = new java.util.HashMap<>();
            m.put("源作者：", "辞晨");   /* 模拟用户在登录界面输入了作者名 */
            m.put("mykey", "[0,\"MjA5MjA5MjA5MjA5=\"]");
            return m; 
        }
        public String getKey(){ return "gate-test"; }
        public void setVariable(String s){ }
        public FakeCache cache = mkCache();
        static FakeCache mkCache(){
            FakeCache c = new FakeCache();
            c.m.put("mykey", "[0,\"MjA5MjA5MjA5MjA5MjA5MjA5MjA5MjA5\"]");
            c.m.put("jk", "0");
            return c;
        }
    }
}
