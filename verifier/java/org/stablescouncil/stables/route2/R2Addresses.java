package org.stablescouncil.stables.route2;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.TreeMap;

import org.minima.objects.Address;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;
import org.minima.utils.json.parser.JSONParser;

/**
 * Checks that every contract address in the preserved transactions is the hash of the exact script the transaction
 * executed, computed with Minima's own Address class. Writes each distinct script once, so a reviewer reads the
 * deployed contracts byte for byte rather than the templates in contracts/.
 *
 * Usage: R2Addresses --raw evidence/2026-10-12/raw [--out contracts/deployed]
 */
public final class R2Addresses {
    public static void main(String[] args) throws Exception {
        String raw = null, out = null;
        for (int i = 0; i + 1 < args.length; i += 2) {
            if (args[i].equals("--raw")) raw = args[i + 1];
            if (args[i].equals("--out")) out = args[i + 1];
        }
        if (raw == null) { System.err.println("usage: R2Addresses --raw <dir> [--out <dir>]"); System.exit(2); }
        Map<String, String> scripts = new TreeMap<>();
        File[] files = new File(raw).listFiles((d, n) -> n.startsWith("txpow-") && n.endsWith(".json"));
        if (files == null) { System.err.println("no raw transactions in " + raw); System.exit(2); }
        for (File f : files) {
            JSONObject tx = (JSONObject) new JSONParser().parse(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            JSONObject resp = (JSONObject) tx.get("response");
            JSONArray ws = (JSONArray) ((JSONObject) ((JSONObject) resp.get("body")).get("witness")).get("scripts");
            for (Object o : ws) {
                JSONObject s = (JSONObject) o;
                scripts.put(((String) s.get("address")).toUpperCase().replace("0X", "0x"), (String) s.get("script"));
            }
        }
        int bad = 0;
        for (Map.Entry<String, String> e : scripts.entrySet()) {
            String computed = new Address(e.getValue()).getAddressData().to0xString().toUpperCase().replace("0X", "0x");
            boolean ok = computed.equals(e.getKey());
            if (!ok) bad++;
            System.out.println((ok ? "PASS " : "FAIL ") + e.getKey() + "  " + e.getValue().length() + " chars"
                + (ok ? "" : "  computed " + computed));
            if (out != null) {
                File dir = new File(out); dir.mkdirs();
                Files.write(new File(dir, e.getKey() + ".kiss").toPath(), (e.getValue() + "\n").getBytes(StandardCharsets.UTF_8));
            }
        }
        System.out.println(scripts.size() + " scripts, " + (scripts.size() - bad) + " addresses match");
        System.exit(bad == 0 ? 0 : 1);
    }
}
