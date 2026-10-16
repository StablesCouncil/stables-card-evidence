package org.stablescouncil.stables.route2;

import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * Route 2 coin holder (trace-design.md 13.9). Every coin is held by a one-use key; paying signs once with each spent
 * coin's key and the hardware destroys it. State is committed durably at each step, so a restart never signs a
 * different body for a coin and never credits twice. Pure Java: the app plugs in TEE keys and an encrypted file,
 * the JVM tests plug in software keys and memory.
 */
public final class R2Wallet {
    /** One-use signing keys. In the app: TEE keys with setMaxUsageCount(1) and attestation. */
    public interface CoinKeys {
        final class Created {
            public final String alias;public final byte[] point,leaf;public final List<byte[]> chain;
            public Created(String alias,byte[] point,byte[] leaf,List<byte[]> chain){this.alias=alias;this.point=point;this.leaf=leaf;this.chain=chain;}
        }
        Created create()throws R2Exception;
        /** A key that also needs the holder's fingerprint before it signs (item 6). Where there is none, a plain key. */
        default Created createStrong()throws R2Exception{return create();}
        /** True when this phone can make fingerprint keys. */
        default boolean strongAvailable(){return false;}
        /** True when this key needs the fingerprint to sign. */
        default boolean isStrong(String alias){return false;}
        /** Signs once. Throws code "key-gone" when the key no longer exists (used or deleted), "auth" when a fingerprint
         *  (or an unlocked phone) is needed first: then nothing was signed and the key is still there. */
        byte[] sign(String alias,byte[] message)throws R2Exception;
        boolean exists(String alias);
        void delete(String alias);
    }
    /** Durable, atomic state. In the app: an AtomicFile encrypted with a keystore AES key, synced before return. */
    public interface Storage { byte[] load()throws Exception; void commit(byte[] state)throws Exception; }

    public static final int HELD=0,SPENDING=1,SPENT=2,LOST=3;
    /** Held, but a deposit it rests on is not seen by this phone's own node: no receiver would accept it. Reversible. */
    public static final int STALE=4;
    /** Left the card: its exit line is signed and its key destroyed; the money is on its way to Savings. */
    public static final int EXITED=5;
    /** Exit record status: line signed, request posted, paid into Savings. */
    /** EXIT_REJECTED: the Council spent the request with only its 1-atom refund; the amount never comes back. */
    public static final int EXIT_SIGNED=0,EXIT_POSTED=1,EXIT_PAID=2,EXIT_REJECTED=3;
    /** REFUSED: written only by the interim build of 2026-10-15 (a signed payment above a limit was refused). Since the
     *  founder's ruling of the same day such a payment is credited and flagged instead; the value stays readable. */
    public static final int OUTSTANDING=0,PAID=1,REFUSED=2;
    /** DECLINED: asked over the network about a payment it never got, this receiver refused the request for good and
     *  signed a refusal with its key (failed payments, 2026-10-16). Never credited afterwards. */
    public static final int DECLINED=3;
    /** A payer's unconfirmed payment as it settles: open (no answer yet), the receiver has it, refused (signed refusal
     *  held), refund request posted, refunded into Savings, refund rejected by the Council. */
    public static final int SETTLE_OPEN=0,SETTLE_HAVE=1,SETTLE_REFUSED=2,SETTLE_POSTED=3,SETTLE_REFUNDED=4,SETTLE_REJECTED=5;
    /** How long after an unanswered payment the payer asks over the network (founder 2026-10-16: "ok" to 2 minutes). */
    public static final long ASK_AFTER_MS=120_000L;

    public static final class Coin {
        public final byte[] id,token,point,leaf,bundle;public final long amount;public final String alias;public final List<byte[]> chain;
        public int status;public final int depth;
        Coin(byte[] id,byte[] token,long amount,String alias,byte[] point,byte[] leaf,List<byte[]> chain,byte[] bundle,int status,int depth){
            this.id=id;this.token=token;this.amount=amount;this.alias=alias;this.point=point;this.leaf=leaf;this.chain=chain;this.bundle=bundle;this.status=status;this.depth=depth;
        }
    }
    static final class Held { final String alias;final byte[] point,leaf;final List<byte[]> chain;
        Held(String a,byte[] p,byte[] l,List<byte[]> c){alias=a;point=p;leaf=l;chain=c;}
        static Held of(CoinKeys.Created c){return new Held(c.alias,c.point,c.leaf,c.chain);}
    }
    static final class Req { final R2Request request;final Held key;int status;Req(R2Request r,Held k,int s){request=r;key=k;status=s;} }
    static final class Load { final byte[] token;final long amount;final Held key;Load(byte[] t,long a,Held k){token=t;amount=a;key=k;} }
    static final class Intent {
        final byte[] body,request;final List<String> parents;final byte[][] sigs;final Held change;
        /** A self-hop (exit preparation): the received coin is this wallet's own key, nothing goes out. */
        Held self;
        Intent(byte[] body,List<String> parents,byte[][] sigs,Held change,byte[] request){this.body=body;this.parents=parents;this.sigs=sigs;this.change=change;this.request=request;}
    }
    /** One exit (trace-design.md 13.11): the signed line and package, and how far the money has gone. */
    public static final class Exit {
        public final byte[] coinId,token,payout,line,pkg;public final long amount;public int status;public String request;
        Exit(byte[] coinId,byte[] token,long amount,byte[] payout,byte[] line,byte[] pkg,int status,String request){
            this.coinId=coinId;this.token=token;this.amount=amount;this.payout=payout;this.line=line;this.pkg=pkg;this.status=status;this.request=request;
        }
    }
    /** Exit body fixed before the signature, and the signature once made (commit points A and B of an exit). */
    static final class ExitIntent { final byte[] body;byte[] sig;ExitIntent(byte[] b,byte[] s){body=b;sig=s;} }
    /** One row per money movement, for the activity list: kind in | out | load | lost. */
    public static final class Event { public final String kind;public final byte[] id,token;public final long amount,ts;
        Event(String k,byte[] i,byte[] t,long a,long ts){kind=k;id=i;token=t;amount=a;this.ts=ts;} }
    public static final class Outgoing { public final byte[] recvKeyHash,bundle,receivedCoinId;public boolean acknowledged;
        /** Failed payments (state v6): when it was signed, the receiver's Savings address (where a question goes), how it
         *  settles, the receiver's signed refusal, the refund request, and when the network was last asked. */
        public long at;public String address;public int settle=SETTLE_OPEN;public boolean guessed;public byte[] refusal;public String refundRequest;public long askedAt;public int asks;
        Outgoing(byte[] k,byte[] b,byte[] id,boolean a){recvKeyHash=k;bundle=b;receivedCoinId=id;acknowledged=a;}
        /** Not answered yet: neither received nor refused. */
        public boolean unconfirmed(){return !acknowledged&&settle==SETTLE_OPEN;}
        /** The amount and token it paid (the last hop of its bundle pays the request). */
        public R2Hop hop()throws R2Exception{R2Hop h=null;for(R2Hop x:R2Bundle.parse(bundle).hops())if(Arrays.equals(R2Codec.keyHash(x.recvPub),recvKeyHash))h=x;
            if(h==null)throw R2Codec.fail("refund","no hop pays this request");return h;}
    }
    /** A receiver's own request bound at first contact to the payer's Savings address, and its refusal once signed. */
    static final class Bind { byte[] payout;byte[] refusal;Bind(byte[] p,byte[] r){payout=p;refusal=r;} }
    private final Map<String,Bind> binds=new LinkedHashMap<>();

    private final CoinKeys keys;private final Storage storage;private final R2Receiver receiver;
    private final Map<String,Coin> coins=new LinkedHashMap<>();
    private final Map<String,Req> requests=new LinkedHashMap<>();
    private final Map<String,Load> loads=new LinkedHashMap<>();
    private final Map<String,Outgoing> outgoing=new LinkedHashMap<>();
    private final Map<String,Exit> exits=new LinkedHashMap<>();
    private ExitIntent exitIntent;
    private final Map<String,byte[]> seen=new LinkedHashMap<>();
    private final Map<String,byte[]> wires=new LinkedHashMap<>();
    private final List<R2Receiver.DoubleSpend> proofs=new ArrayList<>();
    private final List<Event> events=new ArrayList<>();
    /* Certificate chains this wallet holds (its own keys', and every chain of a bundle it accepted), most recent last.
       A payer leaves out the chains its receiver names, so a tap carries about 2.6 KB less per phone. */
    static final int CHAIN_CACHE=16;
    /* A change key made in advance: an attested TEE key takes about 0.3 s on the Graphene (R2-ANDROID-03), more than the
       tap leaves the payer's page (R2-CAMPAIGN-05). Made outside any tap; a payment with change takes it. */
    private Held spare;
    /* A request key made in advance (founder 2026-10-16: the card's Get paid must load at once): a new attested key takes
       0.3 to 1 s in the Graphene's chip, and Get paid made one each time it opened. */
    private Held spareRequest;
    /** Makes the spare change key when there is none. Never call inside a tap. Returns true when one was made. */
    public boolean prepareSpare()throws Exception{
        boolean made=false;
        boolean need;
        synchronized(this){need=spareRequest==null||!keys.exists(spareRequest.alias);}
        if(need){
            CoinKeys.Created k=keys.create();                           // outside the lock
            synchronized(this){
                if(spareRequest!=null&&keys.exists(spareRequest.alias))keys.delete(k.alias);
                else{spareRequest=Held.of(k);remember(k.chain);commit();made=true;}
            }
        }
        synchronized(this){need=spare==null||!keys.exists(spare.alias);}
        if(need){
            CoinKeys.Created k=keys.create();                           // outside the lock: about 0.3 s on the Graphene
            synchronized(this){
                if(spare!=null&&keys.exists(spare.alias))keys.delete(k.alias);
                else{spare=Held.of(k);remember(k.chain);commit();made=true;}
            }
        }
        // The fingerprint spare, for change at or above the fingerprint amount (item 6).
        synchronized(this){need=strongAt>0&&keys.strongAvailable()&&(spareStrong==null||!keys.exists(spareStrong.alias))
                &&clock.getAsLong()-strongFailedAt>STRONG_RETRY_MS;}
        if(need){
            CoinKeys.Created k=keys.createStrong();
            synchronized(this){
                // A phone that made a plain key instead (no fingerprint after all) tries again in ten minutes, not every call.
                if(!keys.isStrong(k.alias)){keys.delete(k.alias);strongFailedAt=clock.getAsLong();}
                else if(spareStrong!=null&&keys.exists(spareStrong.alias))keys.delete(k.alias);
                else{spareStrong=Held.of(k);remember(k.chain);commit();made=true;}
            }
        }
        return made;
    }
    /** The change key for this much change: plain when it is small or all goes into the quick purse (purseAfter: what
     *  the purse holds once this payment's plain coins are spent); else a fingerprint key, when one is ready. */
    private Held changeKey(long change,long purseAfter)throws R2Exception{
        boolean toPurse=purseAfter+change<=purse();
        if(!toPurse&&wantsStrong(change)&&spareStrong!=null&&keys.exists(spareStrong.alias)){Held h=spareStrong;spareStrong=null;return h;}
        Held h=spare!=null&&keys.exists(spare.alias)?spare:Held.of(keys.create());spare=null;return h;
    }
    private long purseAfter(byte[] token,List<Coin> parents){
        long p=plainHeld(token);for(Coin c:parents)if(plain(c))p-=c.amount;return Math.max(0,p);
    }
    private final LinkedHashMap<String,List<byte[]>> chains=new LinkedHashMap<>();
    private void remember(List<byte[]> chain){
        String id=R2Codec.hex(R2Attestation.chainId(chain));chains.remove(id);chains.put(id,chain);
        while(chains.size()>CHAIN_CACHE)chains.remove(chains.keySet().iterator().next());
    }
    /** Ids of the chains this wallet holds, most recent first: what its coin requests tell payers. */
    public synchronized List<byte[]> knownChainIds(int max){
        List<String> ids=new ArrayList<>(chains.keySet());List<byte[]> out=new ArrayList<>();
        for(int i=ids.size()-1;i>=0&&out.size()<max;i--)out.add(R2Codec.unhex(ids.get(i)));
        return out;
    }
    private Intent intent;
    private final List<String> recoveryNotes=new ArrayList<>();

    /* CARD HARDENING (CARD_HARDENING_PLAN.md items 4 and 6). What this wallet received, by paying phone, for the receiving
       limits (the last 48 hours are kept); the amount from which a coin is held by a fingerprint key; a spare fingerprint
       key for change, made outside any tap like the plain spare. */
    static final class Received { final long ts;final byte[] chain,token;final long amount;Received(long ts,byte[] c,byte[] t,long a){this.ts=ts;chain=c;token=t;amount=a;} }
    private final List<Received> received=new ArrayList<>();
    private Held spareStrong;
    private long strongFailedAt=Long.MIN_VALUE/2;static final long STRONG_RETRY_MS=10*60*1000L;
    private long strongAt;
    private java.util.function.LongSupplier clock=System::currentTimeMillis;
    /** Tests move time. */
    void clock(java.util.function.LongSupplier c){clock=c;}
    /** Coins of at least this many atoms are held by fingerprint keys from now on (0: never). */
    public synchronized void strongAt(long atoms){strongAt=Math.max(0,atoms);}
    private long purseTarget=-1;
    /** The quick purse target in atoms (-1: twice the fingerprint amount). */
    public synchronized void purseTarget(long atoms){purseTarget=Math.max(-1,atoms);}
    /** The fingerprint amount and the quick purse from the person's settings. */
    public synchronized void limits(R2Limits l){strongAt=l.strongAt;purseTarget=l.purseTarget;}
    /* THE QUICK PURSE (founder 2026-10-15: "no more than one request for fingerprint and amounts below the thresholds can
       go without"). Plain-key coins up to purse() pay anything below the fingerprint amount with no fingerprint. A payment
       at or above it, or one the purse cannot cover, asks once; within that same 30-second authorisation refill() tops the
       purse up from a fingerprint coin. Nothing ever asks a second time: a signature that would need a fingerprint outside
       an authorised moment is undone, not prompted. */
    long purse(){if(strongAt<=0)return 0;return purseTarget>=0?purseTarget:2*strongAt;}
    private boolean plain(Coin c){return !keys.isStrong(c.alias);}
    /** Plain-key coins held in this token (the quick purse as it stands). */
    public synchronized long plainHeld(byte[] token){long s=0;for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&plain(c))s+=c.amount;return s;}
    /** The coins a payment of this amount takes: below the fingerprint amount the quick purse when it covers it; at or
     *  above it fingerprint coins first when they cover it (the purse kept); otherwise any. */
    private List<Coin> payParents(byte[] token,long amount,java.util.function.Predicate<Coin> eligible)throws R2Exception{
        if(strongAt>0){
            java.util.function.Predicate<Coin> first=amount<strongAt?this::plain:c->!plain(c);
            try{return select(token,amount,c->eligible.test(c)&&first.test(c));}catch(R2Exception e){/* the wider choice below */}
        }
        return select(token,amount,eligible);
    }
    private boolean wantsStrong(long amount){return strongAt>0&&amount>=strongAt&&keys.strongAvailable();}

    public R2Wallet(CoinKeys keys,Storage storage,R2Receiver receiver)throws Exception{
        this.keys=keys;this.storage=storage;this.receiver=receiver;
        byte[] s=storage.load();if(s!=null)decode(s);
        recover();
    }

    // ---- Load: a deposit names a fresh first key K0; the coin exists once the chain holds the deposit ----------------
    /** Creates K0 for a deposit of this amount. The deposit's port 1 must be keyHash(K0). */
    public synchronized byte[] prepareLoad(byte[] token,long amount)throws Exception{
        if(token.length!=32||R2Hop.isNative(token)||amount<=0)throw R2Codec.fail("load","shape");
        CoinKeys.Created k=keys.create();
        loads.put(R2Codec.hex(k.point),new Load(token,amount,Held.of(k)));commit();
        return k.point.clone();
    }
    /** After the deposit confirms: checks it through the own node and holds the root coin. */
    public synchronized Coin completeLoad(byte[] k0,byte[] anchorCoinId,byte[] exportProof)throws Exception{
        Load l=loads.get(R2Codec.hex(k0));if(l==null)throw R2Codec.fail("load","no prepared load for this key");
        R2Bundle.Anchor a=new R2Bundle.Anchor(anchorCoinId,l.token,l.amount,k0,exportProof);
        receiver.checkAnchor(a);
        String id=R2Codec.hex(a.rootId());if(coins.containsKey(id))throw R2Codec.fail("load","anchor already held");
        Coin c=new Coin(a.rootId(),l.token,l.amount,l.key.alias,l.key.point,l.key.leaf,l.key.chain,new R2Bundle().addAnchor(a).encode(),HELD,0);
        coins.put(id,c);loads.remove(R2Codec.hex(k0));events.add(new Event("load",c.id,c.token,c.amount,System.currentTimeMillis()));commit();
        return c;
    }

    /**
     * Load into an outstanding request: a vault deposit whose port 1 names this request's key is that request paid by
     * the chain. Checked through the own node like any anchor; the request's amount and token must match exactly.
     */
    public Coin claimDeposit(byte[] anchorCoinId,byte[] exportProof)throws Exception{
        // The node read happens outside the wallet lock (R2-CAMPAIGN-07); the anchor check after it is answered from cache.
        String root=R2Codec.hex(R2Bundle.Anchor.rootId(anchorCoinId));
        synchronized(this){if(coins.containsKey(root))return coins.get(root);}
        R2Receiver.AnchorView v=receiver.anchorView(anchorCoinId,exportProof);
        return claimSeen(anchorCoinId,exportProof,root,v);
    }
    private synchronized Coin claimSeen(byte[] anchorCoinId,byte[] exportProof,String root,R2Receiver.AnchorView v)throws Exception{
        if(coins.containsKey(root))return coins.get(root);
        String named=v.found&&v.state!=null?v.state.get(1):null;
        for(Req q:requests.values()){
            if(q.status!=OUTSTANDING||!namesKey(named,q.request.keyHash()))continue;
            // An open request takes the deposit's amount from the anchor's kept amount (port 2): a stage 2 anchor coin
            // itself holds only 1 atom (founder's Pro, build 109: "amount port differs", the Add never credited).
            long amount=q.request.openAmount()?depositAmount(v):q.request.amount;
            R2Bundle.Anchor a=new R2Bundle.Anchor(anchorCoinId,q.request.token,amount,q.request.recvPub,exportProof);
            receiver.checkAnchor(a);
            Coin c=new Coin(a.rootId(),a.token,a.amount,q.key.alias,q.key.point,q.key.leaf,q.key.chain,new R2Bundle().addAnchor(a).encode(),HELD,0);
            coins.put(root,c);q.status=PAID;events.add(new Event("load",c.id,c.token,c.amount,System.currentTimeMillis()));commit();
            return c;
        }
        throw R2Codec.fail("load","the deposit names none of this wallet's outstanding requests");
    }
    /** The amount a deposit put in: its anchor's port 2 (R2T1, where it equals the coin, and stage 2, where the anchor
     *  holds 1 atom and the money sits in the vault). */
    static long depositAmount(R2Receiver.AnchorView v)throws R2Exception{
        String p2=v.state==null?null:v.state.get(2);
        return p2!=null?R2Codec.atoms(p2.trim()):R2Codec.atoms(v.amount);
    }
    /**
     * Whether a deposit's port 1 (as a node prints it: 0x or 0X prefix, any case) names this outstanding request key.
     * One comparison form for every caller; R2-CAMPAIGN-03 lost a load to a 0x/0X mismatch.
     */
    public static boolean namesKey(String port1,byte[] keyHash){
        if(port1==null||keyHash==null)return false;
        String v=port1.trim();if(v.startsWith("0x")||v.startsWith("0X"))v=v.substring(2);
        return v.equalsIgnoreCase(R2Codec.hex(keyHash));
    }
    /** True when port 1 names one of this wallet's outstanding requests. */
    public synchronized boolean namesOutstanding(String port1){
        for(Req q:requests.values())if(q.status==OUTSTANDING&&namesKey(port1,q.request.keyHash()))return true;
        return false;
    }
    /** The receiver confirmed a payment (NFC or Bluetooth answer): the payer's row reads received. */
    public synchronized boolean markDelivered(byte[] recvKeyHash)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));
        if(o==null)return false;
        if(!o.acknowledged){o.acknowledged=true;commit();}
        return true;
    }
    /**
     * Sets aside held coins whose deposit this phone's node positively reports as gone or unknown (STALE), and brings
     * them back when it is seen again. A node that cannot answer changes nothing. Returns how many coins changed.
     */
    public int refreshAnchors()throws Exception{
        // Node reads happen outside the wallet lock: a payment in a tap never waits behind them (R2-CAMPAIGN-07).
        List<Coin> look=new ArrayList<>();
        synchronized(this){for(Coin c:coins.values())if(c.status==HELD||c.status==STALE)look.add(c);}
        Map<String,Integer> want=new LinkedHashMap<>();
        for(Coin c:look){
            Boolean ok=true;
            for(R2Bundle.Anchor a:R2Bundle.parse(c.bundle).anchors()){
                R2Receiver.AnchorView v;
                try{v=receiver.anchorView(a.coinId,a.proof.length==0?null:a.proof);}catch(Exception e){ok=null;break;}
                if(v==null||!v.found||v.spent){ok=false;break;}
            }
            if(ok!=null)want.put(R2Codec.hex(c.id),ok?HELD:STALE);
        }
        synchronized(this){
            int changed=0;
            for(Map.Entry<String,Integer> e:want.entrySet()){
                Coin c=coins.get(e.getKey());
                if(c==null||(c.status!=HELD&&c.status!=STALE)||c.status==e.getValue())continue;
                c.status=e.getValue();changed++;
            }
            if(changed>0)commit();
            return changed;
        }
    }
    /** Key hashes of outstanding requests: what a load deposit's port 1 may name. */
    /** Every load this wallet credited, as {request key hash, coin id}: the page's "To Stables card" row is matched by the
     *  key hash and turns Added (founder's Pro, build 111: a claim reported once was missed and the row stayed Broadcasted). */
    public synchronized List<byte[][]> creditedLoads(){
        List<byte[][]> l=new ArrayList<>();
        for(Req q:requests.values()){
            if(q.status!=PAID)continue;
            for(Coin c:coins.values())if(c.alias.equals(q.key.alias)){l.add(new byte[][]{q.request.keyHash(),c.id});break;}
        }
        return l;
    }
    public synchronized List<byte[]> outstandingKeyHashes(){
        List<byte[]> l=new ArrayList<>();for(Req q:requests.values())if(q.status==OUTSTANDING)l.add(q.request.keyHash());return l;
    }

    // ---- Receive ------------------------------------------------------------------------------------------------------
    public synchronized byte[] newRequest(byte[] token,long amount)throws Exception{
        // A request for a set amount at or above the fingerprint amount is held by a fingerprint key from the start; an
        // open request cannot know, and a large coin it receives moves to a fingerprint key later (protectLarge).
        Held h;
        if(amount>0&&wantsStrong(amount))h=Held.of(keys.createStrong());
        else if(spareRequest!=null&&keys.exists(spareRequest.alias)){h=spareRequest;spareRequest=null;}   // made in advance: no wait
        else h=Held.of(keys.create());
        byte[] nonce=new byte[16];new SecureRandom().nextBytes(nonce);
        R2Request r=new R2Request(token,amount,h.point,nonce);
        requests.put(R2Codec.hex(r.keyHash()),new Req(r,h,OUTSTANDING));remember(h.chain);commit();
        return r.encode();
    }
    /** Checks a payment bundle; on acceptance commits the coin, the request and the seen set atomically. */
    public synchronized R2Receiver.Result receive(byte[] bundle)throws Exception{return receive(bundle,R2Limits.none(),false);}
    /**
     * Same, counting it against the receiving limits this person set (item 4, and the one-touch cap while the revocation
     * list is over 30 days old, item 3). The limits are enforced before signing (checkIntent, first contact); a signed
     * payment that still arrives above one (a payer without the intent step) is CREDITED, never lost, and flagged:
     * Result.limitKind and limitAtoms name the limit it is above (founder 2026-10-15).
     */
    public synchronized R2Receiver.Result receive(byte[] bundle,R2Limits limits,boolean listStale)throws Exception{
        R2Receiver.Result r=receiver.check(bundle,ledger());
        if(r.proof!=null){proofs.add(r.proof);commit();return r;}
        if(!r.accepted)return r;
        R2Limits.Refusal over=limits.check(r.amount,r.payerChains,usedToday(r.token),listStale);
        if(over!=null&&accepted(r.token,r.amount,over)){over=null;acceptToken=null;}   // the person accepted this one payment
        if(over!=null){r.limitKind=over.kind;r.limitAtoms=over.limit;}
        long now=clock.getAsLong();
        for(String c:r.payerChains)received.add(new Received(now,R2Codec.unhex(c),r.token,r.amount));
        pruneReceived(now);
        Req q=requests.get(R2Codec.hex(r.keyHash));
        coins.put(R2Codec.hex(r.coinId),new Coin(r.coinId,r.token,r.amount,q.key.alias,q.key.point,q.key.leaf,q.key.chain,r.resolved,HELD,r.depth));
        for(List<byte[]> c:r.chains)remember(c);
        q.status=PAID;events.add(new Event("in",r.coinId,r.token,r.amount,System.currentTimeMillis()));
        for(R2Receiver.Seen s:r.seen){seen.put(R2Codec.hex(s.parent),s.bodyHash);wires.put(R2Codec.hex(s.bodyHash),s.wire);}
        commit();
        return r;
    }
    /** What each paying phone paid this wallet in this token over the last 24 hours (chain id hex to atoms). */
    public synchronized Map<String,Long> usedToday(byte[] token){
        long since=clock.getAsLong()-R2Limits.DAY_MS;Map<String,Long> m=new LinkedHashMap<>();
        for(Received x:received)if(x.ts>since&&Arrays.equals(x.token,token))m.merge(R2Codec.hex(x.chain),x.amount,Long::sum);
        return m;
    }
    private void pruneReceived(long now){received.removeIf(x->x.ts<now-2*R2Limits.DAY_MS||x.ts>now+R2Limits.DAY_MS);}
    /** The "Coin limit" this receiver shows payers (R2Limits.Offer: its per-payment cap now). */
    public synchronized byte[] limitOffer(byte[] token,R2Limits limits,boolean listStale){return limits.offer(listStale);}
    /** First contact, receiver side: the limit this intent is above, or null when this receiver takes it. Nothing stored. */
    public synchronized R2Limits.Refusal checkIntent(R2Limits.Intent i,R2Limits limits,boolean listStale){
        // Only the intent's own chains are counted, by bytes: this runs on the card side's thread inside a tap.
        long since=clock.getAsLong()-R2Limits.DAY_MS;Map<String,Long> used=new LinkedHashMap<>();
        for(byte[] c:i.chains){
            long u=0;for(Received x:received)if(x.ts>since&&Arrays.equals(x.token,i.token)&&Arrays.equals(x.chain,c))u+=x.amount;
            used.put(R2Codec.hex(c),u);
        }
        R2Limits.Refusal r=limits.check(i.amount,i.chainHex(),used,listStale);
        if(r!=null&&!accepted(i.token,i.amount,r))return r;
        return bind(i);
    }
    /**
     * Failed payments (2026-10-16): an intent naming one of this receiver's outstanding requests binds that request to the
     * payer's Savings address, which a later refusal names. One request is one payer's: another payer's intent for a
     * request already bound is answered BUSY, nothing is signed, and the receiver shows a fresh code. Two payments to one
     * request key would leave one of them unspendable and unrefundable (the key signs once).
     */
    private R2Limits.Refusal bind(R2Limits.Intent i){
        if(i.keyHash==null)return null;
        String kh=R2Codec.hex(i.keyHash);Req q=requests.get(kh);
        if(q==null||q.status!=OUTSTANDING)return null;
        Bind b=binds.get(kh);
        if(b!=null&&b.payout!=null)return Arrays.equals(b.payout,i.payout)?null:new R2Limits.Refusal(R2Limits.BUSY,0);
        binds.put(kh,new Bind(i.payout.clone(),null));
        try{commit();}catch(Exception e){binds.remove(kh);return null;}
        return null;
    }
    /** The Savings address bound to this request at first contact, or null. */
    public synchronized byte[] boundPayout(byte[] keyHash){Bind b=binds.get(R2Codec.hex(keyHash));return b==null||b.payout==null?null:b.payout.clone();}

    // ---- Failed payments: the network question and its signed answer (2026-10-16) ----------------------------------------
    /** The receiver's answer to "do you have payment X?": HAVE (the STR2K acknowledgement of the coin it credited),
     *  REFUSED (the signed refusal), PENDING (a fingerprint key must sign it first) or UNKNOWN (not this phone's request). */
    public static final class Answer { public final String kind;public final byte[] bytes;Answer(String k,byte[] b){kind=k;bytes=b;} }
    public static final String HAVE="have",REFUSE="refused",PENDING="pending",UNKNOWN="unknown",GONE="gone";
    /**
     * Answers a payer's network question about one of this receiver's requests. Credited: the acknowledgement of the
     * coin credited for it (its id is known only to whoever holds the payment). Not credited: the request is marked
     * DECLINED and committed FIRST, so no bundle for it is ever credited afterwards, then the refusal is signed with the
     * request's own one-use key and stored; asked again, the same refusal. The refusal names the address the payer gave
     * at first contact; only a request with no first contact (an older payer) takes the question's address.
     */
    public synchronized Answer answerAsk(byte[] keyHash,byte[] questionPayout)throws Exception{
        String kh=R2Codec.hex(keyHash);Req q=requests.get(kh);
        if(q==null)return new Answer(UNKNOWN,null);
        if(q.status==PAID){
            for(Coin c:coins.values())if(c.alias.equals(q.key.alias))return new Answer(HAVE,R2Request.ack(c.id));
            return new Answer(UNKNOWN,null);
        }
        Bind b=binds.get(kh);
        if(q.status==DECLINED&&b!=null&&b.refusal!=null)return new Answer(REFUSE,b.refusal.clone());
        byte[] payout=b!=null&&b.payout!=null?b.payout:questionPayout;
        if(payout==null||payout.length!=32)return new Answer(UNKNOWN,null);
        if(q.status!=DECLINED){
            q.status=DECLINED;if(b==null){b=new Bind(payout.clone(),null);binds.put(kh,b);}else if(b.payout==null)b.payout=payout.clone();
            commit();                                                   // refused for good BEFORE the key signs
        }
        if(!keys.exists(q.key.alias)){recoveryNotes.add("refusal of "+kh.substring(0,8)+" lost: its key is gone");return new Answer(GONE,null);}
        byte[] nonce=new byte[16];new SecureRandom().nextBytes(nonce);
        R2Refusal r=new R2Refusal(keyHash,b.payout,nonce);
        byte[] sig;
        try{sig=keys.sign(q.key.alias,r.body);}                          // the hardware destroys the request key here
        catch(R2Exception e){if(e.code.equals("auth"))return new Answer(PENDING,null);throw e;}
        b.refusal=r.sign(sig,q.key.leaf,q.key.chain).wire();
        commit();
        return new Answer(REFUSE,b.refusal.clone());
    }
    /** Every request this receiver refused over the network, as {keyHash, refusal wire}. */
    public synchronized List<byte[][]> refusals(){
        List<byte[][]> l=new ArrayList<>();
        for(Map.Entry<String,Bind> e:binds.entrySet()){Req q=requests.get(e.getKey());if(q!=null&&q.status==DECLINED&&e.getValue().refusal!=null)l.add(new byte[][]{R2Codec.unhex(e.getKey()),e.getValue().refusal.clone()});}
        return l;
    }

    /** Payer: the receiver's Savings address (from its code), where a question about this payment goes. */
    public synchronized void noteReceiver(byte[] recvKeyHash,String address)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));
        if(o==null||address==null||address.isEmpty()||address.equals(o.address))return;
        o.address=address;o.asks=0;o.askedAt=0;commit();
    }
    /**
     * Payer: a receiver code read by this phone names its Savings address; unconfirmed payments that never learned their
     * receiver's address (signed before 0.0.13.031) take it. A wrong guess costs nothing: a receiver that does not own the
     * request never answers, and the next code read is tried in its turn. Returns how many took it.
     */
    public synchronized int learnAddress(String address)throws Exception{
        if(address==null||address.isEmpty())return 0;
        int n=0;for(Outgoing o:outgoing.values())if(o.unconfirmed()&&(o.address==null||(o.guessed&&!address.equals(o.address)&&o.asks>=GUESS_ASKS))){o.address=address;o.guessed=true;o.asks=0;o.askedAt=0;n++;}
        if(n>0)commit();
        return n;
    }
    /** Questions back off: 2, 4, 8, 16, 32 then every 64 minutes, at most MAX_ASKS per address (then the next contact). */
    static final int MAX_ASKS=12,GUESS_ASKS=3;
    static long askSpacing(int asks){return ASK_AFTER_MS<<Math.min(asks,5);}
    /** Payer: the unconfirmed payments due a network question now (signed over ASK_AFTER_MS ago, the back-off passed). */
    public synchronized List<Outgoing> dueQuestions(long now){
        List<Outgoing> l=new ArrayList<>();
        for(Outgoing o:outgoing.values())if(o.unconfirmed()&&o.address!=null&&o.at>0&&now-o.at>=ASK_AFTER_MS&&o.asks<(o.guessed?GUESS_ASKS:MAX_ASKS)
                &&(o.askedAt==0||now-o.askedAt>=askSpacing(o.asks-1)))l.add(o);
        return l;
    }
    public synchronized void asked(byte[] recvKeyHash,long now)throws Exception{Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));if(o!=null){o.askedAt=now;o.asks++;commit();}}
    /**
     * Payer: the receiver's answer, from the network. An acknowledgement must name the coin this payment made (only the
     * real receiver knows it): the row reads received. A refusal must be signed by the key this payment paid, for this
     * request: it is kept for the refund. Anything else changes nothing. Returns the settle state after it.
     */
    public synchronized int takeAnswer(byte[] recvKeyHash,byte[] answer)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));
        if(o==null)throw R2Codec.fail("answer","no payment to this request");
        if(o.acknowledged)return SETTLE_HAVE;
        if(answer.length>5&&answer[4]=='K'){
            byte[] id=R2Request.parseAck(answer);
            if(!Arrays.equals(id,o.receivedCoinId))throw R2Codec.fail("answer","the acknowledgement names another coin");
            o.acknowledged=true;o.settle=SETTLE_HAVE;commit();return SETTLE_HAVE;
        }
        if(o.settle!=SETTLE_OPEN)return o.settle;
        R2Refusal r=R2Refusal.fromWire(answer);
        if(!Arrays.equals(r.keyHash,recvKeyHash))throw R2Codec.fail("answer","the refusal names another request");
        if(!r.signedBy(o.hop().recvPub))throw R2Codec.fail("signature","the refusal is not signed by the key this payment paid");
        o.refusal=answer.clone();o.settle=SETTLE_REFUSED;commit();
        return SETTLE_REFUSED;
    }
    /** Payer: the refund package for a refused payment (the refusal and the bundle this phone signed). */
    public synchronized byte[] refundPackage(byte[] recvKeyHash)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));
        if(o==null||o.refusal==null)throw R2Codec.fail("refund","no refusal held for this payment");
        return R2Refusal.pack(R2Refusal.fromWire(o.refusal),o.bundle);
    }
    public synchronized void refundProgress(byte[] recvKeyHash,int settle,String request)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));if(o==null)throw R2Codec.fail("refund","unknown payment");
        if(settle<o.settle)return;
        o.settle=settle;if(request!=null)o.refundRequest=request;commit();
    }
    /* ACCEPT ONCE (founder 2026-10-15: "the receiver should have a way to overwrite that easily, just a confirmation that's
       ok to go"). After a refusal at first contact the receiver's person can accept that one payment: this token, up to
       this amount, for the next ACCEPT_MS. Their own limits only (per payment, per paying phone a day); the out-of-date
       security list is never waived, it guards against revoked keys the person cannot judge. Used up by the payment it
       lets in. Held in memory only: an app restart forgets it. */
    static final long ACCEPT_MS=120_000L;
    private byte[] acceptToken;private long acceptAtoms,acceptUntil;
    public synchronized void acceptOnce(byte[] token,long amount){
        acceptToken=token.clone();acceptAtoms=amount;acceptUntil=clock.getAsLong()+ACCEPT_MS;
    }
    private boolean accepted(byte[] token,long amount,R2Limits.Refusal r){
        return acceptToken!=null&&!R2Limits.STALE.equals(r.kind)&&Arrays.equals(acceptToken,token)&&amount<=acceptAtoms
            &&clock.getAsLong()<=acceptUntil;
    }
    /** First contact, payer side: what paying this amount would spend from, as an intent; null when the card cannot. */
    public synchronized R2Limits.Intent intentFor(byte[] token,long amount){
        if(amount<=0)return null;
        List<Coin> parents;
        try{parents=payParents(token,amount,c->true);}catch(R2Exception e){return null;}
        List<byte[]> ch=new ArrayList<>();
        for(Coin c:parents){byte[] id=R2Attestation.chainId(c.chain);boolean dup=false;for(byte[] x:ch)if(Arrays.equals(x,id))dup=true;if(!dup)ch.add(id);}
        return new R2Limits.Intent(token,amount,ch);
    }
    private R2Receiver.Ledger ledger(){
        return new R2Receiver.Ledger(){
            // Only unpaid requests: a later bundle may pass through a coin this receiver was paid earlier.
            public R2Request outstanding(byte[] kh){Req q=requests.get(R2Codec.hex(kh));return q==null||q.status!=OUTSTANDING?null:q.request;}
            public boolean credited(byte[] kh){Req q=requests.get(R2Codec.hex(kh));return q!=null&&q.status==PAID;}
            public byte[] seenSpender(byte[] parent){
                byte[] s=seen.get(R2Codec.hex(parent));if(s!=null)return s;
                // The receiver's own spends count too: a coin it paid away cannot come back by another hop.
                if(intent!=null&&intent.parents.contains(R2Codec.hex(parent)))return R2Codec.sha256(intent.body);
                return null;
            }
            public byte[] seenWire(byte[] bodyHash){return wires.get(R2Codec.hex(bodyHash));}
            public List<byte[]> knownChain(byte[] chainId){return chains.get(R2Codec.hex(chainId));}
            public boolean refused(byte[] kh){Req q=requests.get(R2Codec.hex(kh));return q!=null&&q.status==DECLINED;}
        };
    }

    // ---- Pay ----------------------------------------------------------------------------------------------------------
    /** Pays a request. Returns the bundle to deliver. Paying the same request again returns the same payment. */
    public synchronized byte[] pay(byte[] requestBytes)throws Exception{return pay(requestBytes,0,java.util.Collections.<String>emptySet());}
    public synchronized byte[] pay(byte[] requestBytes,java.util.Set<String> receiverChains)throws Exception{return pay(requestBytes,0,receiverChains);}
    /**
     * Same, for an amount (0: the request's own amount; required for an open request, refused when it differs from
     * a fixed one), leaving out the certificate chains the receiver said it holds (chain ids, lowercase hex).
     */
    public synchronized byte[] pay(byte[] requestBytes,long payAmount,java.util.Set<String> receiverChains)throws Exception{return pay(requestBytes,payAmount,receiverChains,null);}
    /**
     * Same, within what the receiver said it takes (its "Coin limit" offer, or null): above it nothing is signed and the
     * refusal (code "receiver-limit") carries the most this payer may pay there, in atoms.
     */
    public synchronized byte[] pay(byte[] requestBytes,long payAmount,java.util.Set<String> receiverChains,R2Limits.Offer offer)throws Exception{
        return pay(requestBytes,payAmount,receiverChains,offer,null);
    }
    /* SIGN ONLY WHILE THE PHONES TOUCH (failed payments, 2026-10-16). In a tap, `touching` is asked immediately before each
       coin key signs. Phones already apart: nothing is signed, the coins are held again and a change key made for this
       payment is kept as the spare (code "touch-ended"). Founder's phones, 0.0.13.031: the touch was live when the payment
       began, then the Graphene made a change key inside the touch (about 1 s) and signed after the phones had parted. */
    private java.util.function.BooleanSupplier touching;
    public synchronized byte[] pay(byte[] requestBytes,long payAmount,java.util.Set<String> receiverChains,R2Limits.Offer offer,
                                   java.util.function.BooleanSupplier stillTouching)throws Exception{
        touching=stillTouching;
        try{return payIn(requestBytes,payAmount,receiverChains,offer);}finally{touching=null;}
    }
    private byte[] payIn(byte[] requestBytes,long payAmount,java.util.Set<String> receiverChains,R2Limits.Offer offer)throws Exception{
        R2Request q=R2Request.parse(requestBytes);
        long amount=q.openAmount()?payAmount:(payAmount==0?q.amount:payAmount);
        if(amount<=0)throw R2Codec.fail("pay","an amount is required");
        if(!q.openAmount()&&amount!=q.amount)throw R2Codec.fail("pay","amount differs from the request");
        Outgoing done=outgoing.get(R2Codec.hex(q.keyHash()));if(done!=null)return R2Bundle.parse(done.bundle).encode(receiverChains);
        // The same payment, stopped for a fingerprint after a first signature: finished now (its body is fixed).
        if(intent!=null&&intent.self==null&&Arrays.equals(intent.request,requestBytes))return R2Bundle.parse(continueIntent()).encode(receiverChains);
        if(intent!=null||exitIntent!=null)throw R2Codec.fail("pay","a payment is in progress");
        if(requests.containsKey(R2Codec.hex(q.keyHash())))throw R2Codec.fail("pay","this is our own request");
        List<Coin> parents=strongFirst(payParents(q.token,amount,c->true));
        if(offer!=null){
            List<byte[]> mine=new ArrayList<>();for(Coin c:parents)mine.add(R2Attestation.chainId(c.chain));
            long room=offer.room(mine);
            if(amount>room)throw R2Codec.fail("receiver-limit",String.valueOf(room));
        }
        long sum=0;for(Coin c:parents)sum+=c.amount;
        Held change=null;
        if(sum>amount)change=changeKey(sum-amount,purseAfter(q.token,parents));
        List<byte[]> ids=new ArrayList<>();for(Coin c:parents)ids.add(c.id);
        R2Hop hop=new R2Hop(q.token,ids,q.recvPub,amount,change==null?null:change.point,sum-amount);
        List<String> pids=new ArrayList<>();for(Coin c:parents){pids.add(R2Codec.hex(c.id));c.status=SPENDING;}
        intent=new Intent(hop.body,pids,new byte[parents.size()][],change,requestBytes.clone());
        commit();                                                       // commit point A: body fixed before any signature
        return R2Bundle.parse(continueIntent()).encode(receiverChains);
    }
    private List<Coin> select(byte[] token,long amount)throws R2Exception{return select(token,amount,c->true);}
    /** Fingerprint coins sign first: when the fingerprint has run out, nothing at all has been signed and the payment is
     *  undone (continueIntent). */
    private List<Coin> strongFirst(List<Coin> l){
        List<Coin> out=new ArrayList<>();
        for(Coin c:l)if(keys.isStrong(c.alias))out.add(c);
        for(Coin c:l)if(!keys.isStrong(c.alias))out.add(c);
        return out;
    }
    /** True when paying (or, exit true, removing) this amount of this token signs with a fingerprint key: the page asks
     *  for the fingerprint first. Not enough on the card: false (the payment is refused for that). */
    public synchronized boolean needsFingerprint(byte[] token,long amount,boolean exit){return fingerprintReason(token,amount,exit)!=null;}
    /** Why paying (or removing) this amount asks for the fingerprint: null (it does not), "large" (at or above the
     *  fingerprint amount, from fingerprint coins) or "refill" (below it, but the quick purse cannot cover it). */
    public synchronized String fingerprintReason(byte[] token,long amount,boolean exit){
        if(amount<=0)return null;
        if(exit)for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&c.amount==amount)return keys.isStrong(c.alias)?"large":null;
        try{for(Coin c:payParents(token,amount,x->true))if(keys.isStrong(c.alias))return strongAt>0&&amount<strongAt?"refill":"large";}
        catch(R2Exception e){return null;}
        return null;
    }
    /** How many held coins are held by fingerprint keys (every token). */
    public synchronized int strongHeld(){int n=0;for(Coin c:coins.values())if(c.status==HELD&&!plain(c))n++;return n;}
    /**
     * Moves every fingerprint coin back to plain keys (up to four coins per move), within one fingerprint the person just
     * gave: before removing the screen lock, which destroys fingerprint keys, or after setting the fingerprint amount to
     * 0. Stops without asking when the 30 seconds run out. Returns how many coins moved.
     */
    public synchronized int unprotect()throws Exception{
        int moved=0;
        while(intent==null&&exitIntent==null){
            List<Coin> group=new ArrayList<>();byte[] token=null;
            for(Coin c:coins.values()){
                if(c.status!=HELD||plain(c)||c.depth>=R2Codec.RE_ANCHOR_DEPTH)continue;
                if(token==null)token=c.token;
                if(Arrays.equals(token,c.token)&&group.size()<R2Codec.MAX_PARENTS)group.add(c);
            }
            if(group.isEmpty())break;
            Held own=spare!=null&&keys.exists(spare.alias)?spare:Held.of(keys.create());if(own==spare)spare=null;
            long sum=0;List<byte[]> ids=new ArrayList<>();List<String> pids=new ArrayList<>();
            for(Coin c:group){sum+=c.amount;ids.add(c.id);pids.add(R2Codec.hex(c.id));c.status=SPENDING;}
            R2Hop hop=new R2Hop(token,ids,own.point,sum,null,0);
            intent=new Intent(hop.body,pids,new byte[group.size()][],null,new byte[0]);intent.self=own;
            commit();
            try{continueIntent();}catch(R2Exception e){if(e.code.equals("auth"))break;throw e;}
            moved+=group.size();
        }
        return moved;
    }
    /**
     * Within a fingerprint already given (the page calls it right after a payment or a Remove the person confirmed): tops
     * the quick purse up to its target from one fingerprint coin, by a move to this card's own keys (plain for the purse,
     * fingerprint for the rest). If the 30 seconds have passed, nothing is signed and it waits for the next confirmed
     * moment: it never asks. Returns the purse coin made, or null.
     */
    public byte[] refill(byte[] token)throws Exception{
        long deficit;Coin pick=null;
        synchronized(this){
            if(intent!=null||exitIntent!=null||strongAt<=0)return null;
            deficit=purse()-plainHeld(token);
            if(deficit<=0)return null;
            for(Coin c:coins.values()){
                if(c.status!=HELD||!Arrays.equals(c.token,token)||plain(c)||c.depth>=R2Codec.RE_ANCHOR_DEPTH)continue;
                if(pick==null||(c.amount>=deficit&&(pick.amount<deficit||c.amount<pick.amount))||(pick.amount<deficit&&c.amount>pick.amount))pick=c;
            }
            if(pick==null)return null;
        }
        long move=Math.min(deficit,pick.amount),rest=pick.amount-move;
        Held purseKey,restKey=null;
        synchronized(this){purseKey=spare!=null&&keys.exists(spare.alias)?spare:null;if(purseKey!=null)spare=null;}
        if(purseKey==null)purseKey=Held.of(keys.create());          // outside the lock
        if(rest>0){
            synchronized(this){if(spareStrong!=null&&keys.exists(spareStrong.alias)){restKey=spareStrong;spareStrong=null;}}
            if(restKey==null){CoinKeys.Created k=keys.createStrong();restKey=Held.of(k);}
        }
        synchronized(this){
            Coin c=coins.get(R2Codec.hex(pick.id));
            if(intent!=null||exitIntent!=null||c==null||c.status!=HELD){
                keys.delete(purseKey.alias);if(restKey!=null)keys.delete(restKey.alias);return null;
            }
            R2Hop hop=new R2Hop(c.token,java.util.Collections.singletonList(c.id),purseKey.point,move,restKey==null?null:restKey.point,rest);
            c.status=SPENDING;
            intent=new Intent(hop.body,new ArrayList<>(java.util.Collections.singletonList(R2Codec.hex(c.id))),new byte[1][],restKey,new byte[0]);intent.self=purseKey;
            commit();                                                   // commit point A
            try{continueIntent();}
            catch(R2Exception e){if(e.code.equals("auth"))return null;throw e;}   // undone: the next confirmed moment refills
            return hop.recvId();
        }
    }
    /**
     * Item 6: a held coin at or above the fingerprint amount whose key needs no fingerprint (an open request paid with a
     * large amount, a load, change made without a fingerprint spare) moves to a fingerprint key by a self-hop. Never in a
     * tap: the new key is made outside the lock (about 0.3 s). Returns the coin moved, or null.
     */
    public byte[] protectLarge()throws Exception{
        Coin pick=null;long move=0;
        synchronized(this){
            if(intent!=null||exitIntent!=null||strongAt<=0||!keys.strongAvailable()||clock.getAsLong()-strongFailedAt<=STRONG_RETRY_MS)return null;
            // Only what the quick purse holds ABOVE its target, and at least the fingerprint amount, moves to a fingerprint
            // key: a large plain coin is split (the excess to a fingerprint key, the rest back to the purse). It signs with
            // a plain key, so it never asks for the fingerprint.
            for(Coin c:coins.values()){
                if(c.status!=HELD||c.amount<strongAt||keys.isStrong(c.alias)||c.depth>=R2Codec.RE_ANCHOR_DEPTH)continue;
                long excess=plainHeld(c.token)-purse();
                if(excess<strongAt)continue;
                pick=c;move=Math.min(c.amount,excess);break;
            }
        }
        if(pick==null)return null;
        long rest=pick.amount-move;
        CoinKeys.Created k=keys.createStrong();                         // outside the lock: about 0.3 s
        Held back=null;
        if(rest>0){synchronized(this){if(spare!=null&&keys.exists(spare.alias)){back=spare;spare=null;}}if(back==null)back=Held.of(keys.create());}
        synchronized(this){
            Coin c=coins.get(R2Codec.hex(pick.id));
            if(!keys.isStrong(k.alias))strongFailedAt=clock.getAsLong();
            if(!keys.isStrong(k.alias)||intent!=null||exitIntent!=null||c==null||c.status!=HELD){keys.delete(k.alias);if(back!=null)keys.delete(back.alias);return null;}
            Held own=Held.of(k);
            R2Hop hop=new R2Hop(c.token,java.util.Collections.singletonList(c.id),own.point,move,back==null?null:back.point,rest);
            c.status=SPENDING;
            intent=new Intent(hop.body,new ArrayList<>(java.util.Collections.singletonList(R2Codec.hex(c.id))),new byte[1][],back,new byte[0]);intent.self=own;
            commit();                                                   // commit point A, as for a payment
            continueIntent();
            return hop.recvId();
        }
    }
    private List<Coin> select(byte[] token,long amount,java.util.function.Predicate<Coin> eligible)throws R2Exception{
        List<Coin> held=new ArrayList<>();
        for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&eligible.test(c))held.add(c);
        held.sort(Comparator.comparingLong(c->c.amount));
        // One coin when one covers it (the smallest such): a payment carries one history, so it stays small enough for a
        // short touch. Founder's Graphene, 0.0.13.033: two small coins made a 6,222-byte payment the touch could not carry.
        for(Coin c:held)if(c.amount>=amount)return new ArrayList<>(Arrays.asList(c));
        List<Coin> pick=new ArrayList<>();long sum=0;
        for(Coin c:held){if(sum>=amount)break;pick.add(c);sum+=c.amount;}
        if(sum>=amount&&pick.size()<=R2Codec.MAX_PARENTS)return pick;
        List<Coin> largest=new ArrayList<>(held.subList(Math.max(0,held.size()-R2Codec.MAX_PARENTS),held.size()));
        long top=0;for(Coin c:largest)top+=c.amount;
        if(top>=amount)return largest;
        throw R2Codec.fail("pay",sum<amount?"insufficient balance":"amount needs more than "+R2Codec.MAX_PARENTS+" coins");
    }
    private byte[] continueIntent()throws Exception{
        Intent t=intent;R2Hop hop=R2Hop.parseBody(t.body);
        for(int i=0;i<t.parents.size();i++){
            if(t.sigs[i]!=null)continue;
            Coin c=coins.get(t.parents.get(i));
            byte[] sig;
            if(touching!=null&&t.self==null&&!touching.getAsBoolean()){
                undoUnsigned(t);
                if(intent!=null)throw R2Codec.fail("touch-ended","the phones parted after a first signature: the payment waits for the next touch");
                throw R2Codec.fail("touch-ended","the phones parted before the signature: nothing signed");
            }
            try{sig=keys.sign(c.alias,t.body);}                       // the hardware destroys the key here
            catch(R2Exception e){
                if(e.code.equals("auth"))undoUnsigned(t);
                throw e;
            }
            t.sigs[i]=sig;commit();                                     // commit point B: one per signature
        }
        for(int i=0;i<t.sigs.length;i++)hop.setSignature(i,t.sigs[i]);
        R2Bundle b=new R2Bundle();
        for(String p:t.parents){Coin c=coins.get(p);b.merge(R2Bundle.parse(c.bundle));}
        for(String p:t.parents){Coin c=coins.get(p);b.addKey(c.leaf,c.chain);}
        b.addHop(hop);byte[] bundle=b.encode();
        int depth=0;for(String p:t.parents)depth=Math.max(depth,coins.get(p).depth);
        for(String p:t.parents){coins.get(p).status=SPENT;seen.put(p,hop.bodyHash());}
        wires.put(R2Codec.hex(hop.bodyHash()),hop.wire());
        if(t.change!=null)coins.put(R2Codec.hex(hop.changeId()),new Coin(hop.changeId(),hop.token,hop.changeAmount,t.change.alias,t.change.point,t.change.leaf,t.change.chain,bundle,HELD,depth+1));
        if(t.self!=null){
            // A self-hop moves nothing out: the received coin is ours, made to the exact amount an exit needs.
            coins.put(R2Codec.hex(hop.recvId()),new Coin(hop.recvId(),hop.token,hop.recvAmount,t.self.alias,t.self.point,t.self.leaf,t.self.chain,bundle,HELD,depth+1));
            remember(t.self.chain);
        }else{
            Outgoing og=new Outgoing(R2Codec.keyHash(hop.recvPub),bundle,hop.recvId(),false);og.at=clock.getAsLong();
            outgoing.put(R2Codec.hex(og.recvKeyHash),og);
            events.add(new Event("out",hop.recvId(),hop.token,hop.recvAmount,System.currentTimeMillis()));
        }
        intent=null;commit();                                           // commit point C: hop final
        return bundle;
    }
    /** A fingerprint (or an unlock) was needed before any signature of this intent: nothing was signed, so the payment is
     *  undone: its coins are held again and its new keys kept for later. With a signature made it stays, to finish. */
    private void undoUnsigned(Intent t)throws Exception{
        for(byte[] s:t.sigs)if(s!=null)return;
        for(String p:t.parents){Coin c=coins.get(p);if(c.status==SPENDING)c.status=HELD;}
        if(t.change!=null){
            if(keys.isStrong(t.change.alias)&&(spareStrong==null||!keys.exists(spareStrong.alias)))spareStrong=t.change;
            else if(!keys.isStrong(t.change.alias)&&(spare==null||!keys.exists(spare.alias)))spare=t.change;
            else keys.delete(t.change.alias);
        }
        if(t.self!=null)keys.delete(t.self.alias);
        intent=null;commit();
    }
    public synchronized void acknowledge(byte[] ack)throws Exception{
        byte[] id=R2Request.parseAck(ack);
        for(Outgoing o:outgoing.values())if(Arrays.equals(o.receivedCoinId,id)&&!o.acknowledged){o.acknowledged=true;commit();return;}
    }

    /** At open: finish or settle an interrupted payment (trace-design.md 13.9). */
    private void recover()throws Exception{
        recoverExit();
        if(intent==null)return;
        boolean lost=false;
        for(int i=0;i<intent.parents.size();i++)if(intent.sigs[i]==null&&!keys.exists(coins.get(intent.parents.get(i)).alias))lost=true;
        if(!lost){
            // A fingerprint key cannot sign at start: with nothing signed the payment is undone, else it waits for the fingerprint.
            try{continueIntent();recoveryNotes.add("resumed payment");}
            catch(R2Exception e){if(!e.code.equals("auth"))throw e;recoveryNotes.add("payment waits for a fingerprint: "+(intent==null?"undone":"kept"));}
            return;
        }
        // A key was used but its signature never reached storage: the hop can never be completed. Its coins are lost,
        // never duplicated; parents whose keys survive are lost too because their signature can no longer be used.
        for(String p:intent.parents){Coin c=coins.get(p);c.status=LOST;if(keys.exists(c.alias))keys.delete(c.alias);events.add(new Event("lost",c.id,c.token,c.amount,System.currentTimeMillis()));}
        if(intent.change!=null)keys.delete(intent.change.alias);
        if(intent.self!=null)keys.delete(intent.self.alias);
        recoveryNotes.add("payment interrupted between a signature and its commit: "+intent.parents.size()+" coin(s) lost");
        intent=null;commit();
    }

    // ---- Exit (Remove to Savings) --------------------------------------------------------------------------------------
    /**
     * The coin an exit of exactly this amount leaves with: a held coin of that amount, or one made by a self-hop (pay to
     * a fresh key of this wallet, with change), so one coin exits whole (trace-design.md 13.11).
     */
    public synchronized byte[] exitCoin(byte[] token,long amount)throws Exception{return exitCoin(token,amount,c->true);}
    /** Same, using only the coins the caller accepts (R2T2: coins whose every deposit is in the R2T2 vault). */
    public synchronized byte[] exitCoin(byte[] token,long amount,java.util.function.Predicate<Coin> eligible)throws Exception{
        if(amount<=0)throw R2Codec.fail("exit","amount");
        if(intent!=null||exitIntent!=null)throw R2Codec.fail("exit","a payment is in progress");
        for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&c.amount==amount&&eligible.test(c))return c.id.clone();
        long can=0;for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&eligible.test(c))can+=c.amount;
        if(amount>balance(token))throw R2Codec.fail("pay","insufficient balance");
        if(can<amount)throw R2Codec.fail("exit-generation","only "+can+" atoms can leave by an exit");
        List<Coin> parents=payParents(token,amount,eligible);
        long sum=0;for(Coin c:parents)sum+=c.amount;
        parents=strongFirst(parents);
        Held own=Held.of(keys.create()),change=null;
        if(sum>amount)change=changeKey(sum-amount,purseAfter(token,parents));
        List<byte[]> ids=new ArrayList<>();for(Coin c:parents)ids.add(c.id);
        R2Hop hop=new R2Hop(token,ids,own.point,amount,change==null?null:change.point,sum-amount);
        List<String> pids=new ArrayList<>();for(Coin c:parents){pids.add(R2Codec.hex(c.id));c.status=SPENDING;}
        intent=new Intent(hop.body,pids,new byte[parents.size()][],change,new byte[0]);intent.self=own;
        commit();                                                       // commit point A, as for a payment
        continueIntent();
        return hop.recvId();
    }
    /**
     * Signs the exit line of one held coin to this payout address and returns the package. The coin's key is destroyed by
     * the signature, so the coin can never be paid afterwards. Asking again for the same coin returns the same package.
     */
    public synchronized byte[] exit(byte[] coinId,byte[] payout)throws Exception{
        String id=R2Codec.hex(coinId);
        Exit done=exits.get(id);if(done!=null)return done.pkg.clone();
        if(intent!=null||exitIntent!=null)throw R2Codec.fail("exit","a payment is in progress");
        Coin c=coins.get(id);
        if(c==null||c.status!=HELD)throw R2Codec.fail("exit","no held coin with this id");
        byte[] nonce=new byte[16];new SecureRandom().nextBytes(nonce);
        R2Exit line=new R2Exit(c.id,c.token,c.amount,payout,nonce);
        c.status=SPENDING;exitIntent=new ExitIntent(line.body,null);
        commit();                                                       // commit point A: the body is fixed
        return finishExit();
    }
    private byte[] finishExit()throws Exception{
        R2Exit line=R2Exit.parseBody(exitIntent.body);Coin c=coins.get(R2Codec.hex(line.coinId));
        if(exitIntent.sig==null){
            try{exitIntent.sig=keys.sign(c.alias,line.body);}            // the hardware destroys the key
            catch(R2Exception e){
                // A fingerprint was needed: nothing was signed and the coin stays on the card.
                if(e.code.equals("auth")){c.status=HELD;exitIntent=null;commit();}
                throw e;
            }
            commit();                                                   // commit point B
        }
        line.sign(exitIntent.sig);
        R2Bundle b=R2Bundle.parse(c.bundle);b.addKey(c.leaf,c.chain);
        byte[] pkg=R2Exit.pack(line,b.encode());
        c.status=EXITED;
        exits.put(R2Codec.hex(c.id),new Exit(c.id,c.token,c.amount,line.payout,line.wire(),pkg,EXIT_SIGNED,null));
        events.add(new Event("exit",c.id,c.token,c.amount,System.currentTimeMillis()));
        exitIntent=null;commit();                                       // commit point C: the coin has left the card
        return pkg;
    }
    private void recoverExit()throws Exception{
        if(exitIntent==null)return;
        R2Exit line=R2Exit.parseBody(exitIntent.body);Coin c=coins.get(R2Codec.hex(line.coinId));
        if(exitIntent.sig!=null||keys.exists(c.alias)){
            try{finishExit();recoveryNotes.add("resumed exit");}
            catch(R2Exception e){if(!e.code.equals("auth"))throw e;recoveryNotes.add("exit undone: a fingerprint is needed");}
            return;
        }
        // The key signed but the signature never reached storage: the exit cannot be completed; the coin is lost, never duplicated.
        c.status=LOST;events.add(new Event("lost",c.id,c.token,c.amount,System.currentTimeMillis()));
        recoveryNotes.add("exit interrupted between the signature and its commit: 1 coin lost");
        exitIntent=null;commit();
    }
    /** The app posted the exit request (its transaction id), or saw it paid into Savings. */
    /** A Remove the Council rejected (its package was inline and too large to be paid out, before 0.0.13.037) goes again,
     *  its package in carriers: the same signed package, a new request. Returns that package. */
    public synchronized byte[] exitAgain(byte[] coinId)throws Exception{
        Exit e=exits.get(R2Codec.hex(coinId));if(e==null)throw R2Codec.fail("exit","unknown exit");
        if(e.status!=EXIT_REJECTED)throw R2Codec.fail("exit","only a rejected exit goes again");
        // Only a rejection for size: a package too large to be paid out inline. Rejected for any other reason, it stays so.
        if(e.pkg.length<=R2Exit.INLINE_MAX)throw R2Codec.fail("exit","rejected for another reason than its size");
        e.status=EXIT_SIGNED;e.request=null;commit();
        return e.pkg.clone();
    }
    /** The same for a refund the Council rejected: held as refused again, so its refund is posted once more. A refund still
     *  waiting on a request that carries its package inline above INLINE_MAX goes again too: that request can never be
     *  spent, not by a payout, the fallback or a rejection (all three outsize a block: 70,262 and 85,717 bytes, 2026-10-16). */
    public synchronized void refundAgain(byte[] recvKeyHash)throws Exception{
        Outgoing o=outgoing.get(R2Codec.hex(recvKeyHash));
        if(o==null||(o.settle!=SETTLE_REJECTED&&o.settle!=SETTLE_POSTED)||o.refusal==null)throw R2Codec.fail("refund","only a rejected or stuck refund goes again");
        if(refundPackage(recvKeyHash).length<=R2Exit.INLINE_MAX)throw R2Codec.fail("refund","rejected for another reason than its size");
        o.settle=SETTLE_REFUSED;o.refundRequest=null;commit();
    }
    public synchronized void exitProgress(byte[] coinId,int status,String request)throws Exception{
        Exit e=exits.get(R2Codec.hex(coinId));if(e==null)throw R2Codec.fail("exit","unknown exit");
        if(status<e.status)return;
        e.status=status;if(request!=null)e.request=request;commit();
    }
    public synchronized List<Exit> exits(){return new ArrayList<>(exits.values());}

    // ---- Coin refresh (failed payments, layer 1, 2026-10-16) ------------------------------------------------------------
    /* KEEP BUNDLES SMALL. Every coin carries its history since its deposit; on 2026-10-15 a payment's bundle grew from 2,255
       bytes in the morning to 22,687 at night, and a large bundle needs 3 to 5 s of steady contact where the founder's
       touches last under 1 s. A held coin whose history passes REFRESH_BYTES (counted without certificate chains, which a
       receiver usually holds already) is refreshed on chain by the app in the background: a Remove of exactly that coin to
       this phone's Savings, then an Add of the same amount, whose new coin starts with a one-anchor history. Fingerprint
       coins are left alone (refreshing them would ask). See feedback_coin_refresh_opportunistic. */
    /* 3,000 (0.0.13.041): one hand-over adds about 1,030 bytes (1,217 -> 2,247 measured 2026-10-16), so a coin is refreshed
       only when its next payment would pass about 4 KB. At 1,600 (0.0.13.031 to .040) almost every coin received was sent
       through the Council again (founder: "I dont know why it is not final on the Pro directly"). */
    public static final int REFRESH_BYTES=3000;
    /** A coin's history as a payment would carry it, without certificate chains (bytes). */
    public static int historyBytes(Coin c)throws R2Exception{
        R2Bundle b=R2Bundle.parse(c.bundle);java.util.Set<String> all=new java.util.HashSet<>();
        for(List<byte[]> ch:b.chains())all.add(R2Codec.hex(R2Attestation.chainId(ch)));
        return b.encode(all).length;
    }
    /** Held plain-key coins whose history passed the limit, largest history first. */
    public synchronized List<Coin> refreshDue(int maxBytes,java.util.function.Predicate<Coin> eligible){
        List<Coin> l=new ArrayList<>();final Map<String,Integer> size=new LinkedHashMap<>();
        if(intent!=null||exitIntent!=null)return l;
        for(Coin c:coins.values()){
            if(c.status!=HELD||!plain(c)||!eligible.test(c))continue;
            int n;try{n=historyBytes(c);}catch(R2Exception e){continue;}
            if(n>maxBytes){l.add(c);size.put(R2Codec.hex(c.id),n);}
        }
        l.sort((x,y)->size.get(R2Codec.hex(y.id))-size.get(R2Codec.hex(x.id)));
        return l;
    }

    // ---- Views --------------------------------------------------------------------------------------------------------
    public synchronized long balance(byte[] token){long s=0;for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token))s+=c.amount;return s;}
    public synchronized List<Coin> coins(){return new ArrayList<>(coins.values());}
    public synchronized List<Outgoing> outgoing(){return new ArrayList<>(outgoing.values());}
    public synchronized List<R2Receiver.DoubleSpend> proofs(){return new ArrayList<>(proofs);}
    public synchronized List<String> recoveryNotes(){return new ArrayList<>(recoveryNotes);}
    public synchronized boolean paying(){return intent!=null||exitIntent!=null;}
    public synchronized List<Event> events(){return new ArrayList<>(events);}
    public synchronized Outgoing outgoingFor(byte[] recvKeyHash){return outgoing.get(R2Codec.hex(recvKeyHash));}

    // ---- Durable state ------------------------------------------------------------------------------------------------
    private void commit()throws Exception{storage.commit(encode());}
    private static void held(Out o,Held h){o.var16(h.alias.getBytes(java.nio.charset.StandardCharsets.UTF_8)).raw(h.point).var16(h.leaf).u8(h.chain.size());for(byte[] c:h.chain)o.var16(c);}
    private static Held held(In in)throws R2Exception{
        String a=new String(in.var16(256),java.nio.charset.StandardCharsets.UTF_8);byte[] p=in.raw(65),l=in.var16(R2Codec.MAX_CERT);
        int n=in.u8();List<byte[]> c=new ArrayList<>();for(int i=0;i<n;i++)c.add(in.var16(R2Codec.MAX_CERT));return new Held(a,p,l,c);
    }
    byte[] encode(){
        Out o=new Out().ascii("STR2W").u8(6);
        o.u32(coins.size());for(Coin c:coins.values()){o.raw(c.id).raw(c.token).u64(c.amount);held(o,new Held(c.alias,c.point,c.leaf,c.chain));o.var32(c.bundle).u8(c.status).u8(c.depth);}
        o.u32(requests.size());for(Req q:requests.values()){o.var16(q.request.encode());held(o,q.key);o.u8(q.status);}
        o.u32(loads.size());for(Load l:loads.values()){o.raw(l.token).u64(l.amount);held(o,l.key);}
        o.u32(outgoing.size());for(Outgoing g:outgoing.values())o.raw(g.recvKeyHash).var32(g.bundle).raw(g.receivedCoinId).bool(g.acknowledged);
        o.u32(seen.size());for(Map.Entry<String,byte[]> e:seen.entrySet())o.raw(R2Codec.unhex(e.getKey())).raw(e.getValue());
        o.u32(wires.size());for(Map.Entry<String,byte[]> e:wires.entrySet())o.raw(R2Codec.unhex(e.getKey())).var16(e.getValue());
        o.u32(proofs.size());for(R2Receiver.DoubleSpend p:proofs)o.raw(p.parent).opt(p.first).opt(p.second);
        o.u32(events.size());for(Event e:events)o.var16(e.kind.getBytes(java.nio.charset.StandardCharsets.US_ASCII)).raw(e.id).raw(e.token).u64(e.amount).u64(e.ts);
        o.bool(intent!=null);
        if(intent!=null){o.var16(intent.body).var16(intent.request).u8(intent.parents.size());
            for(int i=0;i<intent.parents.size();i++)o.raw(R2Codec.unhex(intent.parents.get(i))).opt(intent.sigs[i]);
            o.bool(intent.change!=null);if(intent.change!=null)held(o,intent.change);}
        o.u8(chains.size());for(List<byte[]> c:chains.values()){o.u8(c.size());for(byte[] d:c)o.var16(d);}
        o.bool(spare!=null);if(spare!=null)held(o,spare);
        // Version 4: the self key of an interrupted self-hop, exits, and an interrupted exit.
        o.bool(intent!=null&&intent.self!=null);if(intent!=null&&intent.self!=null)held(o,intent.self);
        o.u32(exits.size());for(Exit e:exits.values()){o.raw(e.coinId).raw(e.token).u64(e.amount).raw(e.payout).var16(e.line).var32(e.pkg).u8(e.status).opt(e.request==null?null:e.request.getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
        o.bool(exitIntent!=null);if(exitIntent!=null)o.var16(exitIntent.body).opt(exitIntent.sig);
        // Version 5: the fingerprint spare and what each paying phone paid (receiving limits).
        o.bool(spareStrong!=null);if(spareStrong!=null)held(o,spareStrong);
        o.u32(received.size());for(Received x:received)o.u64(x.ts).raw(x.chain).raw(x.token).u64(x.amount);
        // Version 6: failed payments. Each outgoing payment's settling (by its request key hash), each bound request.
        o.u32(outgoing.size());for(Outgoing g:outgoing.values()){o.raw(g.recvKeyHash).u64(g.at).u64(g.askedAt).u8(g.settle).u8(Math.min(255,g.asks)).bool(g.guessed)
            .opt(g.address==null?null:g.address.getBytes(java.nio.charset.StandardCharsets.US_ASCII)).opt(g.refusal)
            .opt(g.refundRequest==null?null:g.refundRequest.getBytes(java.nio.charset.StandardCharsets.US_ASCII));}
        o.u32(binds.size());for(Map.Entry<String,Bind> e:binds.entrySet())o.raw(R2Codec.unhex(e.getKey())).opt(e.getValue().payout).opt(e.getValue().refusal);
        // 0.0.13.042: the request key made in advance (a missing flag reads as none).
        o.bool(spareRequest!=null);if(spareRequest!=null)held(o,spareRequest);
        return o.bytes();
    }
    private void decode(byte[] b)throws R2Exception{
        In in=new In(b);int version=0;
        if(!Arrays.equals(in.raw(5),"STR2W".getBytes(java.nio.charset.StandardCharsets.US_ASCII))||(version=in.u8())<1||version>6)throw R2Codec.fail("store","unknown wallet state");
        for(int i=in.u32();i>0;i--){byte[] id=in.raw(32),t=in.raw(32);long a=in.u64();Held h=held(in);byte[] bundle=in.var32(R2Codec.MAX_BUNDLE);int s=in.u8(),d=in.u8();
            coins.put(R2Codec.hex(id),new Coin(id,t,a,h.alias,h.point,h.leaf,h.chain,bundle,s,d));}
        for(int i=in.u32();i>0;i--){R2Request r=R2Request.parse(in.var16(256));Held h=held(in);requests.put(R2Codec.hex(r.keyHash()),new Req(r,h,in.u8()));}
        for(int i=in.u32();i>0;i--){byte[] t=in.raw(32);long a=in.u64();Held h=held(in);loads.put(R2Codec.hex(h.point),new Load(t,a,h));}
        for(int i=in.u32();i>0;i--){byte[] k=in.raw(32),bundle=in.var32(R2Codec.MAX_BUNDLE),id=in.raw(32);outgoing.put(R2Codec.hex(k),new Outgoing(k,bundle,id,in.bool()));}
        for(int i=in.u32();i>0;i--)seen.put(R2Codec.hex(in.raw(32)),in.raw(32));
        for(int i=in.u32();i>0;i--)wires.put(R2Codec.hex(in.raw(32)),in.var16(4096));
        for(int i=in.u32();i>0;i--)proofs.add(new R2Receiver.DoubleSpend(in.raw(32),in.opt(4096),in.opt(4096)));
        for(int i=in.u32();i>0;i--)events.add(new Event(new String(in.var16(8),java.nio.charset.StandardCharsets.US_ASCII),in.raw(32),in.raw(32),in.u64(),in.u64()));
        if(in.bool()){byte[] body=in.var16(1024),req=in.var16(256);int n=in.u8();List<String> ps=new ArrayList<>();byte[][] sigs=new byte[n][];
            for(int i=0;i<n;i++){ps.add(R2Codec.hex(in.raw(32)));sigs[i]=in.opt(72);}
            Held ch=in.bool()?held(in):null;intent=new Intent(body,ps,sigs,ch,req);}
        if(version>=2)for(int i=in.u8();i>0;i--){int n=in.u8();List<byte[]> c=new ArrayList<>();for(int j=0;j<n;j++)c.add(in.var16(R2Codec.MAX_CERT));chains.put(R2Codec.hex(R2Attestation.chainId(c)),c);}
        else for(Coin c:coins.values())remember(c.chain);
        if(version>=3&&in.bool())spare=held(in);
        if(version>=4){
            if(in.bool()){Held self=held(in);if(intent!=null)intent.self=self;}
            for(int i=in.u32();i>0;i--){byte[] id=in.raw(32),t=in.raw(32);long a=in.u64();byte[] pay=in.raw(32),line=in.var16(512),pkg=in.var32(R2Exit.MAX_PACKAGE);int st=in.u8();byte[] rq=in.opt(256);
                exits.put(R2Codec.hex(id),new Exit(id,t,a,pay,line,pkg,st,rq==null?null:new String(rq,java.nio.charset.StandardCharsets.US_ASCII)));}
            if(in.bool()){byte[] body=in.var16(R2Exit.BODY_SIZE);exitIntent=new ExitIntent(body,in.opt(72));}
        }
        if(version>=5){
            if(in.bool())spareStrong=held(in);
            for(int i=in.u32();i>0;i--)received.add(new Received(in.u64(),in.raw(32),in.raw(32),in.u64()));
        }
        if(version>=6){
            for(int i=in.u32();i>0;i--){byte[] k=in.raw(32);long at=in.u64(),asked=in.u64();int st=in.u8(),asks=in.u8();boolean guess=in.bool();byte[] ad=in.opt(128),rf=in.opt(R2Codec.MAX_BUNDLE),rq=in.opt(256);
                Outgoing g=outgoing.get(R2Codec.hex(k));if(g==null)continue;
                g.at=at;g.askedAt=asked;g.settle=st;g.asks=asks;g.guessed=guess;g.address=ad==null?null:new String(ad,java.nio.charset.StandardCharsets.US_ASCII);g.refusal=rf;
                g.refundRequest=rq==null?null:new String(rq,java.nio.charset.StandardCharsets.US_ASCII);}
            for(int i=in.u32();i>0;i--){byte[] k=in.raw(32);byte[] po=in.opt(32),rf=in.opt(R2Codec.MAX_BUNDLE);binds.put(R2Codec.hex(k),new Bind(po,rf));}
            if(!in.done()&&in.bool())spareRequest=held(in);
        }
        // Older states: an outgoing payment's time is its "out" row's (the payments of 2026-10-15 settle by the same rules).
        for(Outgoing g:outgoing.values())if(g.at==0)for(Event e:events)if("out".equals(e.kind)&&Arrays.equals(e.id,g.receivedCoinId))g.at=e.ts;
        for(Outgoing g:outgoing.values())if(g.acknowledged&&g.settle==SETTLE_OPEN)g.settle=SETTLE_HAVE;
        in.end();
    }
}
