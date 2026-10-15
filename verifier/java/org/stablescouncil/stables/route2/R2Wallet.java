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
    /** REFUSED: a payment to this request was above a receiving limit. The request is retired so that the payer's later
     *  payments (whose bundles carry that coin) are not refused as offering two coins; a new request takes its place. */
    public static final int OUTSTANDING=0,PAID=1,REFUSED=2;

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
        Outgoing(byte[] k,byte[] b,byte[] id,boolean a){recvKeyHash=k;bundle=b;receivedCoinId=id;acknowledged=a;} }

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
    /** Makes the spare change key when there is none. Never call inside a tap. Returns true when one was made. */
    public boolean prepareSpare()throws Exception{
        boolean made=false;
        boolean need;
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
    /** The change key for this much change: a fingerprint key at or above the fingerprint amount, when one is ready. */
    private Held changeKey(long change)throws R2Exception{
        if(wantsStrong(change)&&spareStrong!=null&&keys.exists(spareStrong.alias)){Held h=spareStrong;spareStrong=null;return h;}
        Held h=spare!=null&&keys.exists(spare.alias)?spare:Held.of(keys.create());spare=null;return h;
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
        CoinKeys.Created k=amount>0&&wantsStrong(amount)?keys.createStrong():keys.create();byte[] nonce=new byte[16];new SecureRandom().nextBytes(nonce);
        R2Request r=new R2Request(token,amount,k.point,nonce);
        requests.put(R2Codec.hex(r.keyHash()),new Req(r,Held.of(k),OUTSTANDING));remember(k.chain);commit();
        return r.encode();
    }
    /** Checks a payment bundle; on acceptance commits the coin, the request and the seen set atomically. */
    public synchronized R2Receiver.Result receive(byte[] bundle)throws Exception{return receive(bundle,R2Limits.none(),false);}
    /**
     * Same, within the receiving limits this person set (item 4) and, while the revocation list is older than 30 days,
     * no more than the one-touch limit (item 3). A payment above a limit is refused with nothing stored (code "limit").
     */
    public synchronized R2Receiver.Result receive(byte[] bundle,R2Limits limits,boolean listStale)throws Exception{
        R2Receiver.Result r=receiver.check(bundle,ledger());
        if(r.proof!=null){proofs.add(r.proof);commit();return r;}
        if(!r.accepted)return r;
        R2Limits.Refusal over=limits.check(r.amount,r.payerChains,usedToday(r.token),listStale);
        if(over!=null){
            // Nothing credited. The request is retired (REFUSED), or every later bundle from this payer, which carries this
            // coin, would offer two coins to this receiver and be refused too. The page shows a fresh request.
            Req refused=requests.get(R2Codec.hex(r.keyHash));
            if(refused!=null&&refused.status==OUTSTANDING){refused.status=REFUSED;commit();}
            return R2Receiver.Result.limit(over,r.amount,r.token);
        }
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
    /** The "Coin limit" this receiver shows payers for this token (R2Limits.Offer). */
    public synchronized byte[] limitOffer(byte[] token,R2Limits limits,boolean listStale){return limits.offer(usedToday(token),listStale);}
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
        R2Request q=R2Request.parse(requestBytes);
        long amount=q.openAmount()?payAmount:(payAmount==0?q.amount:payAmount);
        if(amount<=0)throw R2Codec.fail("pay","an amount is required");
        if(!q.openAmount()&&amount!=q.amount)throw R2Codec.fail("pay","amount differs from the request");
        Outgoing done=outgoing.get(R2Codec.hex(q.keyHash()));if(done!=null)return R2Bundle.parse(done.bundle).encode(receiverChains);
        // The same payment, stopped for a fingerprint after a first signature: finished now (its body is fixed).
        if(intent!=null&&intent.self==null&&Arrays.equals(intent.request,requestBytes))return R2Bundle.parse(continueIntent()).encode(receiverChains);
        if(intent!=null||exitIntent!=null)throw R2Codec.fail("pay","a payment is in progress");
        if(requests.containsKey(R2Codec.hex(q.keyHash())))throw R2Codec.fail("pay","this is our own request");
        List<Coin> parents=strongFirst(select(q.token,amount));
        if(offer!=null){
            List<byte[]> mine=new ArrayList<>();for(Coin c:parents)mine.add(R2Attestation.chainId(c.chain));
            long room=offer.room(mine);
            if(amount>room)throw R2Codec.fail("receiver-limit",String.valueOf(room));
        }
        long sum=0;for(Coin c:parents)sum+=c.amount;
        Held change=null;
        if(sum>amount)change=changeKey(sum-amount);
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
    public synchronized boolean needsFingerprint(byte[] token,long amount,boolean exit){
        if(amount<=0)return false;
        if(exit)for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&c.amount==amount)return keys.isStrong(c.alias);
        try{for(Coin c:select(token,amount))if(keys.isStrong(c.alias))return true;}catch(R2Exception e){return false;}
        return false;
    }
    /**
     * Item 6: a held coin at or above the fingerprint amount whose key needs no fingerprint (an open request paid with a
     * large amount, a load, change made without a fingerprint spare) moves to a fingerprint key by a self-hop. Never in a
     * tap: the new key is made outside the lock (about 0.3 s). Returns the coin moved, or null.
     */
    public byte[] protectLarge()throws Exception{
        Coin pick=null;
        synchronized(this){
            if(intent!=null||exitIntent!=null||strongAt<=0||!keys.strongAvailable()||clock.getAsLong()-strongFailedAt<=STRONG_RETRY_MS)return null;
            for(Coin c:coins.values())if(c.status==HELD&&c.amount>=strongAt&&!keys.isStrong(c.alias)&&c.depth<R2Codec.RE_ANCHOR_DEPTH){pick=c;break;}
        }
        if(pick==null)return null;
        CoinKeys.Created k=keys.createStrong();
        synchronized(this){
            Coin c=coins.get(R2Codec.hex(pick.id));
            if(!keys.isStrong(k.alias))strongFailedAt=clock.getAsLong();
            if(!keys.isStrong(k.alias)||intent!=null||exitIntent!=null||c==null||c.status!=HELD){keys.delete(k.alias);return null;}
            Held own=Held.of(k);
            R2Hop hop=new R2Hop(c.token,java.util.Collections.singletonList(c.id),own.point,c.amount,null,0);
            c.status=SPENDING;
            intent=new Intent(hop.body,new ArrayList<>(java.util.Collections.singletonList(R2Codec.hex(c.id))),new byte[1][],null,new byte[0]);intent.self=own;
            commit();                                                   // commit point A, as for a payment
            continueIntent();
            return hop.recvId();
        }
    }
    private List<Coin> select(byte[] token,long amount,java.util.function.Predicate<Coin> eligible)throws R2Exception{
        List<Coin> held=new ArrayList<>();
        for(Coin c:coins.values())if(c.status==HELD&&Arrays.equals(c.token,token)&&eligible.test(c))held.add(c);
        held.sort(Comparator.comparingLong(c->c.amount));
        List<Coin> pick=new ArrayList<>();long sum=0;
        for(Coin c:held){if(sum>=amount)break;pick.add(c);sum+=c.amount;}
        if(sum>=amount&&pick.size()<=R2Codec.MAX_PARENTS)return pick;
        for(Coin c:held)if(c.amount>=amount)return new ArrayList<>(Arrays.asList(c));
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
            outgoing.put(R2Codec.hex(R2Codec.keyHash(hop.recvPub)),new Outgoing(R2Codec.keyHash(hop.recvPub),bundle,hop.recvId(),false));
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
        List<Coin> parents=select(token,amount,eligible);
        long sum=0;for(Coin c:parents)sum+=c.amount;
        parents=strongFirst(parents);
        Held own=Held.of(keys.create()),change=null;
        if(sum>amount)change=changeKey(sum-amount);
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
    public synchronized void exitProgress(byte[] coinId,int status,String request)throws Exception{
        Exit e=exits.get(R2Codec.hex(coinId));if(e==null)throw R2Codec.fail("exit","unknown exit");
        if(status<e.status)return;
        e.status=status;if(request!=null)e.request=request;commit();
    }
    public synchronized List<Exit> exits(){return new ArrayList<>(exits.values());}

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
        Out o=new Out().ascii("STR2W").u8(5);
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
        return o.bytes();
    }
    private void decode(byte[] b)throws R2Exception{
        In in=new In(b);int version=0;
        if(!Arrays.equals(in.raw(5),"STR2W".getBytes(java.nio.charset.StandardCharsets.US_ASCII))||(version=in.u8())<1||version>5)throw R2Codec.fail("store","unknown wallet state");
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
        in.end();
    }
}
