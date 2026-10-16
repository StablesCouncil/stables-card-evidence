package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * The receiver's checks (trace-design.md 13.8), in order, refusing on the first failure with nothing stored.
 * Pure: the caller supplies its own node's view of anchors and its own ledger, and commits the result itself.
 */
public final class R2Receiver {
    public static final String GENERATION="0x52325431",GENERATION_R2T2="0x52325432",GENERATION_R2T3="0x52325433";

    public interface Attester { R2Attestation.Key verifyKey(byte[] leaf,List<byte[]> chain)throws R2Exception; }

    /** The receiver's own node's view of an anchor coin. */
    public static final class AnchorView {
        public final boolean found,spent;public final String address,amount;public final byte[] token;
        public final Map<Integer,String> state;public final long depth;
        /** R2T2 only: whether the anchor's creating transaction proves the deposit (R2Anchors); null when not read. */
        public final Boolean deposit;
        public AnchorView(boolean found,boolean spent,String address,byte[] token,String amount,Map<Integer,String> state,long depth){
            this(found,spent,address,token,amount,state,depth,null);
        }
        public AnchorView(boolean found,boolean spent,String address,byte[] token,String amount,Map<Integer,String> state,long depth,Boolean deposit){
            this.found=found;this.spent=spent;this.address=address;this.token=token;this.amount=amount;this.state=state;this.depth=depth;this.deposit=deposit;
        }
        public static AnchorView missing(){return new AnchorView(false,false,null,null,null,null,0);}
    }
    public interface Chain { AnchorView anchor(byte[] anchorCoinId,byte[] exportProof)throws R2Exception; }

    /** The receiver's own records. */
    public interface Ledger {
        R2Request outstanding(byte[] keyHash);
        boolean credited(byte[] keyHash);
        /** Body hash of the hop this receiver has seen spending the parent, or null. */
        byte[] seenSpender(byte[] parentId);
        byte[] seenWire(byte[] bodyHash);
        /** A certificate chain this receiver already holds, by id, or null. */
        default List<byte[]> knownChain(byte[] chainId){return null;}
        /** Council only: a coin already exited (its seen set of exits). */
        default boolean exited(byte[] coinId){return false;}
        /** A request this receiver refused over the network (signed refusal): never credited afterwards. */
        default boolean refused(byte[] keyHash){return false;}
    }

    public static final class Seen { public final byte[] parent,bodyHash,wire;Seen(byte[] p,byte[] b,byte[] w){parent=p;bodyHash=b;wire=w;} }
    public static final class DoubleSpend { public final byte[] parent,first,second;DoubleSpend(byte[] p,byte[] a,byte[] b){parent=p;first=a;second=b;} }

    public static final class Result {
        public final boolean accepted;public final String code,detail;
        public final byte[] coinId,token,keyHash;public final long amount;public final int depth;
        public final List<Seen> seen;public final DoubleSpend proof;
        /** The accepted bundle with every chain carried, as the receiver stores it; its chains for the receiver's cache. */
        public byte[] resolved;public List<List<byte[]>> chains;
        /** The paying phones: attestation chain ids (hex) of the keys that signed the hop paying this receiver. */
        public List<String> payerChains=new ArrayList<>();
        /** A receiving-limit refusal (code "limit"): which limit (R2Limits.PAYMENT, DAY, STALE) and its amount in atoms. */
        public String limitKind;public long limitAtoms;
        private Result(boolean ok,String code,String detail,byte[] coinId,byte[] token,byte[] keyHash,long amount,int depth,List<Seen> seen,DoubleSpend proof){
            accepted=ok;this.code=code;this.detail=detail;this.coinId=coinId;this.token=token;this.keyHash=keyHash;this.amount=amount;this.depth=depth;this.seen=seen;this.proof=proof;
        }
        static Result refuse(String code,String detail){return new Result(false,code,detail,null,null,null,0,0,null,null);}
        /** Within the rules, but above a limit this receiver set: nothing is stored. */
        static Result limit(R2Limits.Refusal r,long amount,byte[] token){
            Result x=new Result(false,"limit",r.toString(),null,token,null,amount,0,null,null);x.limitKind=r.kind;x.limitAtoms=r.limit;return x;
        }
        static Result doubleSpend(DoubleSpend p){return new Result(false,"double-spend","parent "+R2Codec.hex(p.parent)+" spent by two different hops",null,null,null,0,0,null,p);}
        public boolean reanchorDue(){return depth>R2Codec.RE_ANCHOR_DEPTH;}
    }

    private static final class Coin { final byte[] owner,token;final long amount;final int depth;final List<String> payers;
        Coin(byte[] o,byte[] t,long a,int d){this(o,t,a,d,new ArrayList<String>());}
        Coin(byte[] o,byte[] t,long a,int d,List<String> p){owner=o;token=t;amount=a;depth=d;payers=p;} }

    private final Attester attester;private final Chain chain;private final String vaultAddress;private final int minDepth;
    /** Stage 2 generations this receiver accepts: anchor tag (port 0) to its anchor address. */
    private final Map<String,String> anchorAddresses=new HashMap<>();
    public R2Receiver(Attester attester,Chain chain,String vaultAddress,int minDepth){this(attester,chain,vaultAddress,(String)null,minDepth);}
    /** With the R2T2 anchor address: anchors of both generations are accepted (R2T1 at its vault, R2T2 with a proven deposit). */
    public R2Receiver(Attester attester,Chain chain,String vaultAddress,String anchorAddress,int minDepth){
        this(attester,chain,vaultAddress,anchorAddress==null?java.util.Collections.<String,String>emptyMap():java.util.Collections.singletonMap(GENERATION_R2T2,anchorAddress),minDepth);
    }
    /** Every stage 2 generation by its tag (R2T2, R2T3...): each anchor must sit at its own generation's anchor address. */
    public R2Receiver(Attester attester,Chain chain,String vaultAddress,Map<String,String> anchorAddresses,int minDepth){
        this.attester=attester;this.chain=chain;this.vaultAddress=vaultAddress;this.minDepth=minDepth;
        for(Map.Entry<String,String> e:anchorAddresses.entrySet())this.anchorAddresses.put(e.getKey().toLowerCase(Locale.ROOT),e.getValue());
    }
    /** The anchor address of the stage 2 generation this tag names, or null. */
    String anchorAddressOf(String tag){return tag==null?null:anchorAddresses.get(tag.trim().toLowerCase(Locale.ROOT));}

    public Result check(byte[] bundleBytes,Ledger ledger){
        try{return run(bundleBytes,ledger);}
        catch(R2Exception e){return Result.refuse(e.code,e.getMessage());}
        catch(RuntimeException e){return Result.refuse("parse","malformed: "+e.getClass().getSimpleName());}
    }

    /** Steps 2, 3, 4 and 6 of 13.8 over a parsed bundle: what every coin in it is, who spent what, which keys are attested. */
    private static final class Trace {
        final Map<String,Coin> coins=new HashMap<>();final Map<String,byte[]> spentBy=new HashMap<>();
        final Map<String,R2Attestation.Key> attested=new HashMap<>();final List<Seen> seen=new ArrayList<>();DoubleSpend proof;
    }
    private Trace trace(R2Bundle b,Ledger ledger)throws R2Exception{
        Trace t=new Trace();
        // 2. Every key against the attestation rules; each accepted key is indexed by its keyHash.
        for(R2Bundle.KeyRecord k:b.keys()){R2Attestation.Key a=attester.verifyKey(k.leaf,b.chain(k.chain));t.attested.put(R2Codec.hex(a.keyHash),a);}
        // 3. Every anchor through the receiver's own node.
        for(R2Bundle.Anchor a:b.anchors()){checkAnchor(a);t.coins.put(R2Codec.hex(a.rootId()),new Coin(a.k0,a.token,a.amount,0));}
        // 4 and 6. Every hop in order, with the in-bundle and seen-set double-spend checks.
        Map<String,byte[]> wires=new HashMap<>();
        for(R2Hop h:b.hops()){
            byte[] bodyHash=h.bodyHash(),wire=h.wire();wires.put(R2Codec.hex(bodyHash),wire);
            long sum=0;int depth=0;List<String> payers=new ArrayList<>();
            for(int i=0;i<h.parents.size();i++){
                byte[] pid=h.parents.get(i);String p=R2Codec.hex(pid);
                Coin parent=t.coins.get(p);
                if(parent==null)throw R2Codec.fail("trace","parent "+p+" is neither an anchored root nor an earlier child");
                // A conflict only counts when this hop is validly signed too: nobody can forge a double spend.
                if(!R2Codec.verify(parent.owner,h.body,h.signature(i)))throw R2Codec.fail("signature","hop not signed by the parent's key");
                byte[] other=t.spentBy.get(p);
                if(other!=null){t.proof=new DoubleSpend(pid,wires.get(R2Codec.hex(other)),wire);return t;}
                byte[] prior=ledger.seenSpender(pid);
                if(prior!=null&&!Arrays.equals(prior,bodyHash)){t.proof=new DoubleSpend(pid,ledger.seenWire(prior),wire);return t;}
                if(!Arrays.equals(parent.token,h.token))throw R2Codec.fail("trace","token differs from the parent's");
                if(!t.attested.containsKey(R2Codec.hex(R2Codec.keyHash(parent.owner))))throw R2Codec.fail("attestation","parent key has no accepted attestation");
                if(Arrays.equals(parent.owner,h.recvPub)||(h.changePub!=null&&Arrays.equals(parent.owner,h.changePub)))throw R2Codec.fail("trace","new owner reuses a spent key");
                sum=Math.addExact(sum,parent.amount);depth=Math.max(depth,parent.depth);
                String chainOf=R2Codec.hex(t.attested.get(R2Codec.hex(R2Codec.keyHash(parent.owner))).chainId);
                if(!payers.contains(chainOf))payers.add(chainOf);
                t.spentBy.put(p,bodyHash);t.seen.add(new Seen(pid,bodyHash,wire));
            }
            if(sum!=h.total())throw R2Codec.fail("conservation","parents "+sum+" atoms, outputs "+h.total());
            t.coins.put(R2Codec.hex(h.recvId()),new Coin(h.recvPub,h.token,h.recvAmount,depth+1,payers));
            if(h.changePub!=null)t.coins.put(R2Codec.hex(h.changeId()),new Coin(h.changePub,h.token,h.changeAmount,depth+1,payers));
        }
        return t;
    }

    private Result run(byte[] bundleBytes,Ledger ledger)throws R2Exception{
        // 1. Parse within limits.
        R2Bundle b=R2Bundle.parse(bundleBytes,ledger::knownChain);
        Trace t=trace(b,ledger);
        if(t.proof!=null)return Result.doubleSpend(t.proof);
        Map<String,Coin> coins=t.coins;Map<String,byte[]> spentBy=t.spentBy;List<Seen> seen=t.seen;
        // 5. The payment is the DEEPEST unspent coin owned by one of this receiver's outstanding request keys. A shallower one
        //    is an earlier payment to this receiver that never arrived, carried in this bundle only as the history of the
        //    payer's change: it is not credited by this payment and does not stop it (founder 2026-10-15: "a failed
        //    transaction doesn't fire while the user wasn't expecting it ... they should not block the next transaction").
        //    Two at the same depth stay refused: which one is meant cannot be told.
        String mine=null;R2Request request=null;boolean tie=false;
        for(Map.Entry<String,Coin> e:coins.entrySet()){
            if(spentBy.containsKey(e.getKey()))continue;
            byte[] kh=R2Codec.keyHash(e.getValue().owner);
            R2Request r=ledger.outstanding(kh);
            if(r==null)continue;
            if(mine==null||e.getValue().depth>coins.get(mine).depth){mine=e.getKey();request=r;tie=false;}
            else if(e.getValue().depth==coins.get(mine).depth)tie=true;
        }
        if(tie)throw R2Codec.fail("request","more than one coin offered to this receiver at the same depth");
        if(mine==null){
            // A request refused over the network (its refusal signed) is never credited, even when its bytes arrive later
            // (founder 2026-10-16): the payer is refunded by the Council instead.
            for(Map.Entry<String,Coin> e:coins.entrySet())
                if(!spentBy.containsKey(e.getKey())&&e.getValue().depth>0&&ledger.refused(R2Codec.keyHash(e.getValue().owner)))
                    throw R2Codec.fail("refused","this request was refused; the payer is refunded");
            throw R2Codec.fail("request","no coin paid to an outstanding request of this receiver");
        }
        Coin c=coins.get(mine);byte[] kh=R2Codec.keyHash(c.owner);
        if(ledger.credited(kh))throw R2Codec.fail("request","this request was already paid");
        if(!Arrays.equals(request.token,c.token))throw R2Codec.fail("request","wrong token");
        if(!request.openAmount()&&request.amount!=c.amount)throw R2Codec.fail("request","amount "+c.amount+" differs from the requested "+request.amount);
        if(c.depth==0)throw R2Codec.fail("request","an anchor's root coin is not a payment");
        Result ok=new Result(true,"accepted",null,R2Codec.unhex(mine),c.token,kh,c.amount,c.depth,seen,null);
        ok.resolved=b.encode();ok.chains=b.chains();ok.payerChains=new ArrayList<>(c.payers);
        return ok;
    }

    public AnchorView anchorView(byte[] anchorCoinId,byte[] exportProof)throws R2Exception{return chain.anchor(anchorCoinId,exportProof);}

    /** The council's verdict on an exit package (trace-design.md 13.11). Pure: request ports are compared by the caller. */
    public static final class ExitResult {
        public final boolean accepted;public final String code,detail;public final R2Exit line;public final byte[] packageHash;public final int depth;
        ExitResult(boolean ok,String code,String detail,R2Exit line,byte[] hash,int depth){accepted=ok;this.code=code;this.detail=detail;this.line=line;packageHash=hash;this.depth=depth;}
    }
    /**
     * Checks an exit package: the bundle by 13.8 steps 1 to 4 and 6, the exited coin is in it and no hop in it spends
     * it, the exit line is signed by that coin's own attested key, and token and amount are the coin's. The ledger's
     * seen set is the council's: a coin it saw paid away, or already exited (exited), is refused.
     */
    public ExitResult checkExit(byte[] pkg,Ledger ledger){
        R2Exit line=null;byte[] hash=null;
        try{
            R2Exit.Package p=R2Exit.unpack(pkg);line=p.line;hash=p.hash;
            R2Bundle b=R2Bundle.parse(p.bundle,ledger::knownChain);
            Trace t=trace(b,ledger);
            if(t.proof!=null)return new ExitResult(false,"double-spend","the coin's history holds a double spend",line,hash,0);
            String id=R2Codec.hex(line.coinId);Coin c=t.coins.get(id);
            if(c==null)throw R2Codec.fail("exit","the exited coin is not in its bundle");
            if(t.spentBy.containsKey(id))throw R2Codec.fail("exit","the exited coin is spent inside its own bundle");
            if(ledger.seenSpender(line.coinId)!=null)throw R2Codec.fail("exit","the exited coin was paid away");
            if(ledger.exited(line.coinId))throw R2Codec.fail("exit","the coin has already exited");
            if(!Arrays.equals(c.token,line.token))throw R2Codec.fail("exit","token differs from the coin's");
            if(c.amount!=line.amount)throw R2Codec.fail("exit","amount "+line.amount+" differs from the coin's "+c.amount);
            if(!t.attested.containsKey(R2Codec.hex(R2Codec.keyHash(c.owner))))throw R2Codec.fail("attestation","the exiting key has no accepted attestation");
            if(!R2Codec.verify(c.owner,line.body,line.signature()))throw R2Codec.fail("signature","exit line not signed by the coin's key");
            return new ExitResult(true,"accepted",null,line,hash,c.depth);
        }catch(R2Exception e){return new ExitResult(false,e.code,e.getMessage(),line,hash,0);}
        catch(RuntimeException e){return new ExitResult(false,"parse","malformed: "+e.getClass().getSimpleName(),line,hash,0);}
    }

    /** The Council's verdict on a refund package (R2Refusal): the coin refunded, its amount and token, and the payout. */
    public static final class RefundResult {
        public final boolean accepted;public final String code,detail;public final R2Refusal refusal;public final byte[] coinId,token,packageHash;
        public final long amount;public final int depth;
        RefundResult(boolean ok,String code,String detail,R2Refusal r,byte[] coinId,byte[] token,long amount,byte[] hash,int depth){
            accepted=ok;this.code=code;this.detail=detail;refusal=r;this.coinId=coinId;this.token=token;this.amount=amount;packageHash=hash;this.depth=depth;
        }
        static RefundResult refuse(String code,String detail,R2Refusal r,byte[] hash){return new RefundResult(false,code,detail,r,null,null,0,hash,0);}
    }
    /**
     * Checks a refund package (FAILED_PAYMENTS_SESSION_PROMPT.md layer 3): the payer's bundle by 13.8 steps 1 to 4 and 6;
     * the refusal signed by an attested key whose hash is the refused request; exactly one coin in the bundle paid to that
     * request, not spent inside the bundle, not seen paid away, not already exited or refunded (the ledger's exited set
     * holds both). The payout is the refusal's own; the caller compares the request ports with the result.
     */
    public RefundResult checkRefund(byte[] pkg,Ledger ledger){
        R2Refusal refusal=null;byte[] hash=null;
        try{
            R2Refusal.Package p=R2Refusal.unpack(pkg);refusal=p.refusal;hash=p.hash;
            R2Attestation.Key k=attester.verifyKey(refusal.leaf(),refusal.chain());
            if(!Arrays.equals(R2Codec.keyHash(k.point),refusal.keyHash))throw R2Codec.fail("refusal","the refusing key is not the refused request's key");
            if(!refusal.signedBy(k.point))throw R2Codec.fail("signature","refusal not signed by the request key");
            R2Bundle b=R2Bundle.parse(p.bundle,ledger::knownChain);
            Trace t=trace(b,ledger);
            if(t.proof!=null)return RefundResult.refuse("double-spend","the coin's history holds a double spend",refusal,hash);
            String id=null;Coin c=null;
            for(Map.Entry<String,Coin> e:t.coins.entrySet()){
                if(e.getValue().depth==0||!Arrays.equals(R2Codec.keyHash(e.getValue().owner),refusal.keyHash))continue;
                if(id!=null)throw R2Codec.fail("refund","more than one coin paid to the refused request");
                id=e.getKey();c=e.getValue();
            }
            if(c==null)throw R2Codec.fail("refund","no coin in the bundle is paid to the refused request");
            byte[] coinId=R2Codec.unhex(id);
            if(t.spentBy.containsKey(id))throw R2Codec.fail("refund","the refunded coin is spent inside its own bundle");
            if(ledger.seenSpender(coinId)!=null)throw R2Codec.fail("refund","the refunded coin was paid away");
            if(ledger.exited(coinId))throw R2Codec.fail("refund","the coin has already exited or been refunded");
            return new RefundResult(true,"accepted",null,refusal,coinId,c.token,c.amount,hash,c.depth);
        }catch(R2Exception e){return RefundResult.refuse(e.code,e.getMessage(),refusal,hash);}
        catch(RuntimeException e){return RefundResult.refuse("parse","malformed: "+e.getClass().getSimpleName(),refusal,hash);}
    }

    public void checkAnchor(R2Bundle.Anchor a)throws R2Exception{
        AnchorView v=chain.anchor(a.coinId,a.proof.length==0?null:a.proof);
        String id=R2Codec.hex(a.coinId);
        if(v==null||!v.found)throw R2Codec.fail("anchor","anchor "+id+" not found by this node");
        if(v.spent)throw R2Codec.fail("anchor","anchor "+id+" is spent");
        Map<Integer,String> s=v.state;
        if(s!=null&&anchorAddressOf(s.get(0))!=null){checkStage2(a,v,anchorAddressOf(s.get(0)));return;}
        if(v.address==null||!v.address.equalsIgnoreCase(vaultAddress))throw R2Codec.fail("anchor","anchor is not at the vault");
        if(!Arrays.equals(v.token,a.token))throw R2Codec.fail("anchor","anchor token differs");
        if(R2Codec.atoms(v.amount)!=a.amount)throw R2Codec.fail("anchor","anchor amount differs");
        if(s==null||!hexEq(s.get(0),GENERATION))throw R2Codec.fail("anchor","generation port");
        if(!hexEq(s.get(1),"0x"+R2Codec.hex(R2Codec.keyHash(a.k0))))throw R2Codec.fail("anchor","anchor does not name this first key");
        if(s.get(2)==null||R2Codec.atoms(s.get(2).trim())!=a.amount)throw R2Codec.fail("anchor","amount port differs");
        if(!hexEq(s.get(3),"0x"+R2Codec.hex(a.token)))throw R2Codec.fail("anchor","token port differs");
        if(v.depth<minDepth)throw R2Codec.fail("anchor","anchor has "+v.depth+" confirmations, needs "+minDepth);
    }
    /** Stage 2 (R2T2, R2T3): the anchor holds 1 atom at its generation's anchor address; its value is proven by the deposit transaction (13.11). */
    private void checkStage2(R2Bundle.Anchor a,AnchorView v,String anchorAddress)throws R2Exception{
        Map<Integer,String> s=v.state;
        if(v.address==null||!v.address.equalsIgnoreCase(anchorAddress))throw R2Codec.fail("anchor","anchor is not at its generation's anchor address");
        if(!Arrays.equals(v.token,a.token))throw R2Codec.fail("anchor","anchor token differs");
        if(!hexEq(s.get(1),"0x"+R2Codec.hex(R2Codec.keyHash(a.k0))))throw R2Codec.fail("anchor","anchor does not name this first key");
        if(s.get(2)==null||R2Codec.atoms(s.get(2).trim())!=a.amount)throw R2Codec.fail("anchor","amount port differs");
        if(!hexEq(s.get(3),"0x"+R2Codec.hex(a.token)))throw R2Codec.fail("anchor","token port differs");
        if(v.depth<minDepth)throw R2Codec.fail("anchor","anchor has "+v.depth+" confirmations, needs "+minDepth);
        if(!Boolean.TRUE.equals(v.deposit))throw R2Codec.fail("anchor-deposit","the anchor's deposit transaction does not put its amount in the vault");
    }
    static boolean hexEq(String a,String b){return a!=null&&b!=null&&a.trim().toLowerCase(Locale.ROOT).equals(b.trim().toLowerCase(Locale.ROOT));}
}
