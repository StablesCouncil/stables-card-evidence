package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/** What a payment carries (trace-design.md 13.5): chains, key leaves, anchors and hops, each kept once. */
public final class R2Bundle {
    public static final class Anchor {
        public final byte[] coinId,token,k0,proof;
        public final long amount;
        public Anchor(byte[] coinId,byte[] token,long amount,byte[] k0,byte[] proof)throws R2Exception{
            if(coinId.length!=32||token.length!=32||amount<=0||R2Hop.isNative(token))throw R2Codec.fail("anchor","shape");
            R2Codec.p256(k0);
            if(proof!=null&&proof.length>32768)throw R2Codec.fail("limit","anchor proof");
            this.coinId=coinId.clone();this.token=token.clone();this.amount=amount;this.k0=k0.clone();this.proof=proof==null?new byte[0]:proof.clone();
        }
        public byte[] rootId(){return rootId(coinId);}
        public static byte[] rootId(byte[] anchorCoinId){return R2Codec.sha256(new Out().ascii("STR2A").u8(R2Codec.VERSION).raw(anchorCoinId).bytes());}
    }
    public static final class KeyRecord {
        public final byte[] leaf;public final int chain;
        KeyRecord(byte[] leaf,int chain){this.leaf=leaf;this.chain=chain;}
    }

    private final Map<String,List<byte[]>> chains=new LinkedHashMap<>();
    private final Map<String,KeyRecord> keys=new LinkedHashMap<>();
    private final Map<String,Anchor> anchors=new LinkedHashMap<>();
    private final Map<String,R2Hop> hops=new LinkedHashMap<>();

    public List<List<byte[]>> chains(){return new ArrayList<>(chains.values());}
    public List<KeyRecord> keys(){return new ArrayList<>(keys.values());}
    public List<Anchor> anchors(){return new ArrayList<>(anchors.values());}
    public List<R2Hop> hops(){return new ArrayList<>(hops.values());}
    public List<byte[]> chain(int index){return chains().get(index);}

    /** Adds a key's attestation; the chain is stored once per phone (identical chains share one entry). */
    public R2Bundle addKey(byte[] leaf,List<byte[]> chain)throws R2Exception{
        String cid=R2Codec.hex(R2Attestation.chainId(chain));
        if(!chains.containsKey(cid)){if(chains.size()>=R2Codec.MAX_CHAINS)throw R2Codec.fail("limit","chains");chains.put(cid,new ArrayList<>(chain));}
        int index=new ArrayList<>(chains.keySet()).indexOf(cid);
        String kid=R2Codec.hex(R2Codec.sha256(leaf));
        if(!keys.containsKey(kid)){if(keys.size()>=R2Codec.MAX_KEYS)throw R2Codec.fail("limit","keys");keys.put(kid,new KeyRecord(leaf.clone(),index));}
        return this;
    }
    public R2Bundle addAnchor(Anchor a)throws R2Exception{
        String id=R2Codec.hex(a.coinId);
        if(!anchors.containsKey(id)){if(anchors.size()>=R2Codec.MAX_ANCHORS)throw R2Codec.fail("limit","anchors");anchors.put(id,a);}
        return this;
    }
    /** Hops keep insertion order; callers add parents before children. */
    public R2Bundle addHop(R2Hop h)throws R2Exception{
        if(!h.signed())throw R2Codec.fail("hop","unsigned hop");
        String id=R2Codec.hex(h.bodyHash());
        if(!hops.containsKey(id)){if(hops.size()>=R2Codec.MAX_HOPS)throw R2Codec.fail("limit","hops");hops.put(id,h);}
        return this;
    }
    /** Union with another bundle. Both are topologically ordered, so appending its new hops in order stays ordered. */
    public R2Bundle merge(R2Bundle o)throws R2Exception{
        for(KeyRecord k:o.keys.values())addKey(k.leaf,o.chain(k.chain));
        for(Anchor a:o.anchors.values())addAnchor(a);
        for(R2Hop h:o.hops.values())addHop(h);
        return this;
    }

    /** Resolves a chain named by id (a chain the receiver said it already holds). */
    public interface ChainLookup { List<byte[]> chain(byte[] chainId); }

    /** Full form: every chain carried. What a phone stores. */
    public byte[] encode()throws R2Exception{return encode(java.util.Collections.<String>emptySet());}
    /**
     * Wire form: a chain the receiver already holds is named by its 32-byte id (certificate count 0) instead of carried,
     * about 2.6 KB less per phone (trace-design.md 13.5). Chain indexes and identities are unchanged.
     */
    public byte[] encode(java.util.Set<String> knownChainIds)throws R2Exception{
        Out o=new Out().ascii("STR2B").u8(R2Codec.VERSION).u8(chains.size());
        for(Map.Entry<String,List<byte[]>> e:chains.entrySet()){
            if(knownChainIds.contains(e.getKey())){o.u8(0).raw(R2Codec.unhex(e.getKey()));continue;}
            List<byte[]> c=e.getValue();o.u8(c.size());for(byte[] d:c)o.var16(d);
        }
        o.u16(keys.size());for(KeyRecord k:keys.values())o.u8(k.chain).var16(k.leaf);
        o.u8(anchors.size());for(Anchor a:anchors.values())o.raw(a.coinId).raw(a.token).u64(a.amount).raw(a.k0).var16(a.proof);
        o.u16(hops.size());for(R2Hop h:hops.values())o.raw(h.wire());
        byte[] b=o.bytes();if(b.length>R2Codec.MAX_BUNDLE)throw R2Codec.fail("limit","bundle over "+R2Codec.MAX_BUNDLE+" bytes");
        return b;
    }
    public static R2Bundle parse(byte[] b)throws R2Exception{return parse(b,null);}
    public static R2Bundle parse(byte[] b,ChainLookup lookup)throws R2Exception{
        if(b.length>R2Codec.MAX_BUNDLE)throw R2Codec.fail("limit","bundle size");
        In in=new In(b);in.magic("STR2B");R2Bundle r=new R2Bundle();
        int nc=in.u8();if(nc>R2Codec.MAX_CHAINS)throw R2Codec.fail("limit","chains");
        List<List<byte[]>> cl=new ArrayList<>();java.util.Set<String> refs=new java.util.HashSet<>();
        for(int i=0;i<nc;i++){int n=in.u8();
            if(n==0){byte[] id=in.raw(32);List<byte[]> c=lookup==null?null:lookup.chain(id);
                if(c==null)throw R2Codec.fail("chain-unknown","bundle names a certificate chain this phone does not hold");
                if(!java.util.Arrays.equals(R2Attestation.chainId(c),id))throw R2Codec.fail("parse","chain reference mismatch");
                refs.add(R2Codec.hex(id));cl.add(c);continue;}
            if(n>R2Codec.MAX_CERTS)throw R2Codec.fail("limit","certificates");List<byte[]> c=new ArrayList<>();for(int j=0;j<n;j++)c.add(in.var16(R2Codec.MAX_CERT));cl.add(c);}
        for(List<byte[]> c:cl){String cid=R2Codec.hex(R2Attestation.chainId(c));if(r.chains.put(cid,c)!=null)throw R2Codec.fail("parse","duplicate chain");}
        int nk=in.u16();if(nk>R2Codec.MAX_KEYS)throw R2Codec.fail("limit","keys");
        for(int i=0;i<nk;i++){int ci=in.u8();if(ci>=nc)throw R2Codec.fail("parse","chain index");byte[] leaf=in.var16(R2Codec.MAX_CERT);
            if(r.keys.put(R2Codec.hex(R2Codec.sha256(leaf)),new KeyRecord(leaf,ci))!=null)throw R2Codec.fail("parse","duplicate key");}
        int na=in.u8();if(na>R2Codec.MAX_ANCHORS)throw R2Codec.fail("limit","anchors");
        for(int i=0;i<na;i++){Anchor a=new Anchor(in.raw(32),in.raw(32),in.u64(),in.raw(65),in.var16(32768));
            if(r.anchors.put(R2Codec.hex(a.coinId),a)!=null)throw R2Codec.fail("parse","duplicate anchor");}
        int nh=in.u16();if(nh>R2Codec.MAX_HOPS)throw R2Codec.fail("limit","hops");
        for(int i=0;i<nh;i++){R2Hop h=R2Hop.read(in);if(r.hops.put(R2Codec.hex(h.bodyHash()),h)!=null)throw R2Codec.fail("parse","duplicate hop");}
        in.end();
        if(!java.util.Arrays.equals(r.encode(refs),b))throw R2Codec.fail("parse","non-canonical bundle");
        return r;
    }
}
