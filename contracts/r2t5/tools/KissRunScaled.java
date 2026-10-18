// In-process KISS runner for step 2 (Instant payments: load and offload), with REAL token scaling.
//
// Same method as KissRun.java (Phase 1): the lab node's own Contract class (DevNodesSet/9101/minima.jar, Minima
// 1.0.45.15), one new Contract per input, setGlobals, run, exactly as TxPoWChecker does. It starts no node, opens no
// database and touches no wallet.
//
// The difference: KissRun gave every token scale 0 (raw amount == token units). Here every token coin carries the
// scale a real `tokencreate` gives an 8-decimal token (scale = 44 - 8 = 36, source tokencreate.java), so the raw
// coin amount is the token amount moved 36 places left, and GETINAMT / @AMOUNT / VERIFYOUT / SUMINPUTS go through
// Token.getScaledTokenAmount exactly as on chain. Amounts in the JSON spec are in TOKEN units (what a person reads).
//
// Input: a JSON array of cases, each
//   { "name":..., "script":..., "input":0, "block":2340000, "trace":false,
//     "state":{"port":"value"},
//     "inputs":[{"coinid":"0x..","address":"0x..","amount":"25.5","tokenid":"0x..","scale":36,"storestate":true,
//                "state":{..},"created":2339000}],
//     "outputs":[{"address":"0x..","amount":"1","tokenid":"0x..","storestate":false}],
//     "signatures":["0x<pubkey>"] }
// "scale" is optional (default 36 for any token, 0 for MINIMA 0x00).
// Output: a JSON array of { name, success, instructions, exception, monotonic } on stdout.
import java.math.BigDecimal;
import java.nio.file.*;
import java.util.*;
import org.minima.kissvm.Contract;
import org.minima.objects.*;
import org.minima.objects.base.*;
import org.minima.utils.json.*;
import org.minima.utils.json.parser.JSONParser;

public class KissRunScaled {
    static final String MINIMA = "0x00";

    static int scaleOf(JSONObject c, String tok) {
        if (c.containsKey("scale")) return ((Number) c.get("scale")).intValue();
        return tok.equals(MINIMA) ? 0 : 36;
    }

    static Coin coin(JSONObject c) {
        String tok = (String) c.getOrDefault("tokenid", MINIMA);
        int scale = scaleOf(c, tok);
        String amt = (String) c.get("amount");
        String raw = new BigDecimal(amt).movePointLeft(scale).toPlainString();
        Coin cc = new Coin(new MiniData((String) c.getOrDefault("coinid", "0x00")), new MiniData((String) c.get("address")),
                new MiniNumber(raw), new MiniData(tok), Boolean.TRUE.equals(c.get("storestate")));
        if (!tok.equals(MINIMA)) {
            String total = new BigDecimal("1000000000").movePointLeft(scale).toPlainString();
            cc.setToken(new Token(new MiniData("0x00"), new MiniNumber(scale), new MiniNumber(total),
                    new MiniString("t"), new MiniString("RETURN TRUE")));
        }
        if (c.containsKey("created")) cc.setBlockCreated(new MiniNumber(String.valueOf(c.get("created"))));
        if (c.containsKey("state")) {
            ArrayList<StateVariable> st = new ArrayList<>();
            JSONObject s = (JSONObject) c.get("state");
            for (Object k : s.keySet()) st.add(new StateVariable(Integer.parseInt((String) k), (String) s.get(k)));
            cc.setState(st);
        }
        return cc;
    }

    public static void main(String[] a) throws Exception {
        JSONArray cases = (JSONArray) new JSONParser().parse(new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8"));
        JSONArray out = new JSONArray();
        for (Object o : cases) {
            JSONObject c = (JSONObject) o;
            Transaction txn = new Transaction();
            Witness wit = new Witness();
            JSONObject st = (JSONObject) c.getOrDefault("state", new JSONObject());
            ArrayList<Coin> ins = new ArrayList<>();
            for (Object i : (JSONArray) c.getOrDefault("inputs", new JSONArray())) {
                Coin cc = coin((JSONObject) i); ins.add(cc); txn.addInput(cc);
                // GETINID and friends read the witness coin proofs, as on chain; the MMR proof content is not
                // consulted by the script (the node checks it separately), so an empty proof suffices here.
                wit.addCoinProof(new CoinProof(cc, new org.minima.database.mmr.MMRProof()));
            }
            for (Object i : (JSONArray) c.getOrDefault("outputs", new JSONArray())) txn.addOutput(coin((JSONObject) i));
            // Carry the actual MAST bodies as well as the coin-address scripts.
            for (Object ws : (JSONArray) c.getOrDefault("witnessScripts", new JSONArray())) wit.addScript(new ScriptProof((String) ws));
            for (Object k : st.keySet()) txn.addStateVariable(new StateVariable(Integer.parseInt((String) k), (String) st.get(k)));
            int input = ((Number) c.getOrDefault("input", 0L)).intValue();
            ArrayList<MiniData> sigs = new ArrayList<>();
            for (Object s : (JSONArray) c.getOrDefault("signatures", new JSONArray())) sigs.add(new MiniData((String) s));
            Coin me = ins.get(input);
            String script = (String) c.get("script");
            boolean trace = Boolean.TRUE.equals(c.get("trace"));
            Contract ct = new Contract(script, sigs, wit, txn, me.getState(), trace);
            long block = ((Number) c.getOrDefault("block", 2340000L)).longValue();
            ct.setGlobals(new MiniNumber(block), new MiniNumber(System.currentTimeMillis()), txn, input,
                    me.getBlockCreated() == null ? new MiniNumber(block - 10) : me.getBlockCreated(), script);
            ct.run();
            JSONObject r = new JSONObject();
            r.put("name", c.get("name"));
            r.put("success", ct.isSuccess());
            r.put("instructions", ct.getNumberOfInstructions());
            r.put("exception", ct.getException());
            r.put("monotonic", ct.isMonotonic());
            if (trace) r.put("trace", ct.getCompleteTraceLog());
            out.add(r);
        }
        System.out.println(out.toJSONString());
    }
}
