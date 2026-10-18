import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.minima.database.mmr.MMRData;
import org.minima.database.mmr.MMRProof;
import org.minima.objects.base.MiniData;
import org.minima.objects.base.MiniNumber;

/**
 * Study (2026-10-17): an on-chain record of exited card coins as a sorted linked list in a fixed-depth Merkle tree, built
 * with Minima's own MMRData hashing so the KISS PROOF instruction verifies it. Each occupied leaf is CONCAT(key, next); an
 * empty slot is 0x00. Proving x is absent = proving a leaf (lo, nx) with lo < x < nx. Inserting x = that leaf becomes
 * (lo, x) and an empty slot becomes (x, nx). Prints the KISS state for one insertion.
 */
public class ExitSet {
    static final int DEPTH = Integer.getInteger("depth", 4);
    static final MiniData EMPTY = new MiniData("0x00");
    final java.util.TreeMap<Long, MiniData> leaves = new java.util.TreeMap<>();   // sparse: absent = empty slot 0x00
    static final MMRData[] EMPTYAT = new MMRData[DEPTH + 1];                       // the root of an empty subtree per level
    static { EMPTYAT[0] = leaf(EMPTY); for (int l = 1; l <= DEPTH; l++) EMPTYAT[l] = MMRData.CreateMMRDataParentNode(EMPTYAT[l - 1], EMPTYAT[l - 1]); }

    static MMRData leaf(MiniData d) { return MMRData.CreateMMRDataLeafNode(d, MiniNumber.ZERO); }
    MMRData node(int level, long index) {
        long lo = index << level, hi = (index + 1) << level;
        if (leaves.subMap(lo, hi).isEmpty()) return EMPTYAT[level];
        if (level == 0) return leaf(leaves.get(index));
        return MMRData.CreateMMRDataParentNode(node(level - 1, 2 * index), node(level - 1, 2 * index + 1));
    }
    MMRData root() { return node(DEPTH, 0); }
    MMRProof proof(long index) {
        MMRProof p = new MMRProof();
        long i = index;
        for (int level = 0; level < DEPTH; level++, i /= 2) {
            boolean left = (i % 2) == 1;                         // our node is the right child: the sibling is on the left
            p.addProofChunk(left, node(level, left ? i - 1 : i + 1));
        }
        return p;
    }
    static String hex(MMRProof p) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); p.writeDataStream(new DataOutputStream(b));
        return new MiniData(b.toByteArray()).to0xString();
    }
    static MiniData cat(MiniData a, MiniData b) { return new MiniData(a.to0xString() + b.to0xString().substring(2)); }

    public static void main(String[] a) throws Exception {
        MiniData low = new MiniData("0x" + "00".repeat(16)), high = new MiniData("0x" + "FF".repeat(16));
        MiniData x = new MiniData(a.length > 0 ? a[0] : "0x5A5A5A5A5A5A5A5A0123456789ABCDEF");
        ExitSet s = new ExitSet();
        s.leaves.put(0L, cat(low, high));                           // genesis: the sentinel (0x00..00, 0xFF..FF)
        MMRData rootOld = s.root();
        MMRProof p1 = s.proof(0);
        s.leaves.put(0L, cat(low, x));
        MMRData rootMid = s.root();
        MMRProof p2 = s.proof(1);                                  // the next free slot
        s.leaves.put(1L, cat(x, high));
        MMRData rootNew = s.root();
        System.out.println("x=" + x.to0xString());
        System.out.println("lo=" + low.to0xString());
        System.out.println("nx=" + high.to0xString());
        System.out.println("p1=" + hex(p1));
        System.out.println("p2=" + hex(p2));
        System.out.println("old=" + rootOld.getData().to0xString());
        System.out.println("mid=" + rootMid.getData().to0xString());
        System.out.println("new=" + rootNew.getData().to0xString());
        System.out.println("proofBytes=" + (hex(p1).length() - 2) / 2);
    }
}
