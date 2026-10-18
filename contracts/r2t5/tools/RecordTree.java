import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeMap;
import org.minima.database.mmr.MMRData;
import org.minima.database.mmr.MMRProof;
import org.minima.objects.base.MiniData;
import org.minima.objects.base.MiniNumber;
import org.minima.utils.json.JSONArray;
import org.minima.utils.json.JSONObject;
import org.minima.utils.json.parser.JSONParser;

/**
 * R2T5 exit record (r2t5/contracts/record.kiss): one shard's sorted list of paid card-coin keys as a fixed-depth Merkle
 * tree, with Minima's own MMR hashing so the KISS PROOF instruction checks it. Slot 0 holds the sentinel (0x00..00,
 * next); slot k holds the k-th key inserted, as CONCAT(key, next key in sorted order, or 0xFF..FF). Empty slots are 0x00.
 * Anyone rebuilds the tree from the keys in insertion order (every payout puts its key on chain).
 *
 *   java -cp minima.jar:. RecordTree <spec.json>
 *   spec: { "depth": 24, "keys": ["0x<16 bytes>", ...in insertion order], "insert": "0x<16 bytes>" (optional) }
 *   prints: { "root", and with insert: "lo", "nx", "pa", "pb", "mid", "new", "slot" } (the record's ports 45 to 49, 40)
 */
public class RecordTree {
    static final MiniData EMPTY = new MiniData("0x00");
    static final String LOW = "0x" + "00".repeat(16), HIGH = "0x" + "FF".repeat(16);
    final int depth;
    final TreeMap<Long, MiniData> leaves = new TreeMap<>();
    final MMRData[] emptyAt;

    RecordTree(int depth) {
        this.depth = depth;
        emptyAt = new MMRData[depth + 1];
        emptyAt[0] = leaf(EMPTY);
        for (int l = 1; l <= depth; l++) emptyAt[l] = MMRData.CreateMMRDataParentNode(emptyAt[l - 1], emptyAt[l - 1]);
    }
    static MMRData leaf(MiniData d) { return MMRData.CreateMMRDataLeafNode(d, MiniNumber.ZERO); }
    MMRData node(int level, long index) {
        long lo = index << level, hi = (index + 1) << level;
        if (leaves.subMap(lo, hi).isEmpty()) return emptyAt[level];
        if (level == 0) return leaf(leaves.get(index));
        return MMRData.CreateMMRDataParentNode(node(level - 1, 2 * index), node(level - 1, 2 * index + 1));
    }
    String root() { return node(depth, 0).getData().to0xString(); }
    String proof(long index) throws Exception {
        MMRProof p = new MMRProof();
        long i = index;
        for (int level = 0; level < depth; level++, i /= 2) {
            boolean left = (i % 2) == 1;
            p.addProofChunk(left, node(level, left ? i - 1 : i + 1));
        }
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        p.writeDataStream(new DataOutputStream(b));
        return new MiniData(b.toByteArray()).to0xString();
    }
    static MiniData cat(String a, String b) { return new MiniData(a + b.substring(2)); }
    static String norm(String k) {
        String h = k.toUpperCase().replace("0X", "");
        if (h.length() != 32) throw new IllegalArgumentException("a key is 16 bytes: " + k);
        return "0x" + h;
    }

    /** Lays the keys out: slot 0 the sentinel, slot k the k-th key; each leaf points at its sorted successor. */
    void build(List<String> keys) {
        TreeMap<String, Long> sorted = new TreeMap<>();
        sorted.put(LOW, 0L);
        for (int k = 0; k < keys.size(); k++) if (sorted.put(keys.get(k), (long) k + 1) != null) throw new IllegalArgumentException("key twice: " + keys.get(k));
        leaves.clear();
        for (var e : sorted.entrySet()) {
            String next = sorted.higherKey(e.getKey());
            leaves.put(e.getValue(), cat(e.getKey(), next == null ? HIGH : next));
        }
    }

    public static void main(String[] a) throws Exception {
        JSONObject spec = (JSONObject) new JSONParser().parse(new String(Files.readAllBytes(Paths.get(a[0])), "UTF-8"));
        RecordTree t = new RecordTree(((Number) spec.get("depth")).intValue());
        List<String> keys = new ArrayList<>();
        for (Object k : (JSONArray) spec.getOrDefault("keys", new JSONArray())) keys.add(norm((String) k));
        t.build(keys);
        JSONObject out = new JSONObject();
        out.put("root", t.root());
        if (spec.get("insert") != null) {
            String x = norm((String) spec.get("insert"));
            if (keys.contains(x)) throw new IllegalArgumentException("already in the record: " + x);
            TreeMap<String, Long> sorted = new TreeMap<>();
            sorted.put(LOW, 0L);
            for (int k = 0; k < keys.size(); k++) sorted.put(keys.get(k), (long) k + 1);
            String lo = sorted.lowerKey(x), nx = sorted.higherKey(x);
            if (nx == null) nx = HIGH;
            long loSlot = sorted.get(lo), slot = keys.size() + 1;
            out.put("lo", lo); out.put("nx", nx); out.put("slot", slot);
            out.put("pa", t.proof(loSlot));
            t.leaves.put(loSlot, cat(lo, x));
            out.put("mid", t.root());
            out.put("pb", t.proof(slot));
            t.leaves.put(slot, cat(x, nx));
            out.put("new", t.root());
        }
        System.out.println(out.toJSONString());
    }
}
