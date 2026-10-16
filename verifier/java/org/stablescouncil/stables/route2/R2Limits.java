package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.stablescouncil.stables.route2.R2Codec.In;
import org.stablescouncil.stables.route2.R2Codec.Out;
import org.stablescouncil.stables.route2.R2Codec.R2Exception;

/**
 * Receiving limits the person sets on the Stables card (CARD_HARDENING_PLAN.md items 3, 4 and 6). Pure Java.
 *
 * All amounts are atoms of the token being paid, the same numbers for every token (a token counts in its own units).
 * 0 means no limit (perPayment, perPhoneDay) or off (strongAt). The day is the last 24 hours. A paying phone is the
 * attestation chain id of the keys that paid (R2Attestation.Key.chainId).
 *
 * FIRST CONTACT (founder 2026-10-15: "The limit should be taken into account at the first phones communication and
 * should display on both phones, above limit and refuse the transaction right from the start"). Before anything is
 * signed the payer sends an Intent (token, amount, the chain ids of the coins it would pay from; no signature) and the
 * receiver answers with checkIntent: OK, or the limit it is above. On a refusal neither phone signs. The receiver's
 * code also carries its per-payment cap (Offer) for the advance display where it cannot answer (QR, network).
 * A signed payment that still arrives above a limit (a payer without the intent step) is credited, never lost, and
 * flagged (R2Wallet.receive): the limits decide before signing, they never destroy money after it.
 *
 * Quick purse (founder 2026-10-15: "no more than one request for fingerprint and amounts below the thresholds can go
 * without"): the card keeps plain-key coins up to purse() for payments below strongAt; the rest of a large amount is
 * held by fingerprint keys (R2Wallet).
 */
public final class R2Limits {
    public static final long DAY_MS=24L*60*60*1000;
    /** A revocation list older than this caps received payments at the one-touch limit. */
    public static final long STALE_MS=30L*DAY_MS;
    public static final long DEFAULT_PER_PAYMENT=500L*R2Codec.ATOMS,DEFAULT_PER_PHONE_DAY=1000L*R2Codec.ATOMS,
            DEFAULT_STRONG_AT=100L*R2Codec.ATOMS,DEFAULT_ONE_TOUCH=50L*R2Codec.ATOMS;
    public static final String PAYMENT="payment",DAY="day",STALE="stale";
    /** Not a limit: the request on screen is already another payer's (failed payments, 2026-10-16); show a fresh code. */
    public static final String BUSY="busy";

    public final long perPayment,perPhoneDay,strongAt,oneTouch;
    /** The quick purse target in atoms; -1: the default, twice strongAt. */
    public final long purseTarget;
    public R2Limits(long perPayment,long perPhoneDay,long strongAt,long oneTouch){this(perPayment,perPhoneDay,strongAt,oneTouch,-1);}
    public R2Limits(long perPayment,long perPhoneDay,long strongAt,long oneTouch,long purseTarget){
        if(perPayment<0||perPhoneDay<0||strongAt<0||oneTouch<0||purseTarget<-1)throw new IllegalArgumentException("limits");
        this.perPayment=perPayment;this.perPhoneDay=perPhoneDay;this.strongAt=strongAt;this.oneTouch=oneTouch;this.purseTarget=purseTarget;
    }
    /** What the quick purse is refilled to (plain-key coins), in atoms. */
    public long purse(){return purseTarget>=0?purseTarget:Math.multiplyExact(2L,strongAt);}
    public static R2Limits defaults(){return new R2Limits(DEFAULT_PER_PAYMENT,DEFAULT_PER_PHONE_DAY,DEFAULT_STRONG_AT,DEFAULT_ONE_TOUCH);}
    /** No receiving limit at all (tests, the council). */
    public static R2Limits none(){return new R2Limits(0,0,0,0);}

    /** Why a payment is refused: which limit, and its amount in atoms. */
    public static final class Refusal {
        public final String kind;public final long limit;
        Refusal(String kind,long limit){this.kind=kind;this.limit=limit;}
        @Override public String toString(){return kind+" limit "+R2Codec.decimal(limit);}
    }

    /** The most one payment may be now: perPayment, capped at oneTouch while the revocation list is stale (0: no limit). */
    public long paymentCap(boolean stale){
        if(!stale)return perPayment;
        return perPayment==0?oneTouch:Math.min(perPayment,oneTouch);
    }

    /**
     * The receiver's verdict on one payment of this amount from these paying phones, given what each paid it in the
     * last 24 hours (chain id hex to atoms, this token). Null: within every limit.
     */
    public Refusal check(long amount,Collection<String> payerChains,Map<String,Long> usedToday,boolean stale){
        if(stale&&amount>oneTouch)return new Refusal(STALE,oneTouch);
        if(perPayment>0&&amount>perPayment)return new Refusal(PAYMENT,perPayment);
        if(perPhoneDay>0)for(String c:payerChains){
            Long u=usedToday.get(c);
            if((u==null?0:u)+amount>perPhoneDay)return new Refusal(DAY,perPhoneDay);
        }
        return null;
    }

    // ---- Intent: the payer's question before anything is signed (first contact) ------------------------------------
    static final int INTENT_VERSION=1,INTENT_VERSION_REFUND=2,INTENT_CHAINS=4;
    public static final int ANSWER_OK=0,ANSWER_REFUSED=1,ANSWER_UNKNOWN=2;
    /**
     * What the payer means to pay: token, amount and the chain ids (32 bytes) of the coins it would pay from. Version 2
     * (failed payments, 2026-10-16) adds the request it is for (its key hash) and the payer's Savings address: if this
     * payment is signed and never reaches the receiver, the receiver's refusal names that address, so a refusal read by
     * anyone on the network refunds only this payer. At most 234 bytes: one short APDU.
     */
    public static final class Intent {
        public final byte[] token;public final long amount;public final List<byte[]> chains;
        /** Version 2 only, else null. */
        public final byte[] keyHash,payout;
        public Intent(byte[] token,long amount,List<byte[]> chains){this(token,amount,chains,null,null);}
        public Intent(byte[] token,long amount,List<byte[]> chains,byte[] keyHash,byte[] payout){
            this.token=token.clone();this.amount=amount;this.chains=new ArrayList<>(chains);
            boolean v2=keyHash!=null&&payout!=null&&keyHash.length==32&&payout.length==32;
            this.keyHash=v2?keyHash.clone():null;this.payout=v2?payout.clone():null;
        }
        public Intent withRefund(byte[] keyHash,byte[] payout){return new Intent(token,amount,chains,keyHash,payout);}
        public byte[] encode(){
            Out o=new Out().u8(keyHash==null?INTENT_VERSION:INTENT_VERSION_REFUND).raw(token).u64(amount).u8(Math.min(INTENT_CHAINS,chains.size()));
            for(int i=0;i<Math.min(INTENT_CHAINS,chains.size());i++)o.raw(chains.get(i));
            if(keyHash!=null)o.raw(keyHash).raw(payout);
            return o.bytes();
        }
        public static Intent parse(byte[] b)throws R2Exception{
            In in=new In(b);int v=in.u8();
            if(v!=INTENT_VERSION&&v!=INTENT_VERSION_REFUND)throw R2Codec.fail("parse","intent version");
            byte[] t=in.raw(32);long a=in.u64();int n=in.u8();
            if(a<=0||n>INTENT_CHAINS)throw R2Codec.fail("parse","intent");
            List<byte[]> c=new ArrayList<>();for(int i=0;i<n;i++)c.add(in.raw(32));
            byte[] kh=null,po=null;if(v==INTENT_VERSION_REFUND){kh=in.raw(32);po=in.raw(32);}
            in.end();
            return new Intent(t,a,c,kh,po);
        }
        public List<String> chainHex(){List<String> l=new ArrayList<>();for(byte[] c:chains)l.add(R2Codec.hex(c));return l;}
    }
    /** The receiver's answer: [ANSWER_OK] or [ANSWER_REFUSED, kind (1 payment, 2 day, 3 stale), limit u64], or UNKNOWN. */
    public static byte[] answer(Refusal r){
        if(r==null)return new byte[]{ANSWER_OK};
        int k=PAYMENT.equals(r.kind)?1:DAY.equals(r.kind)?2:BUSY.equals(r.kind)?4:3;
        return new Out().u8(ANSWER_REFUSED).u8(k).u64(r.limit).bytes();
    }
    public static byte[] unknown(){return new byte[]{ANSWER_UNKNOWN};}
    /** The refusal an answer carries, or null (OK or unknown). */
    public static Refusal parseAnswer(byte[] b)throws R2Exception{
        In in=new In(b);int v=in.u8();
        if(v!=ANSWER_REFUSED){in.end();return null;}
        int k=in.u8();long limit=in.u64();in.end();
        if(k<1||k>4||limit<0)throw R2Codec.fail("parse","answer");
        return new Refusal(k==1?PAYMENT:k==2?DAY:k==4?BUSY:STALE,limit);
    }

    // ---- Offer: the per-payment cap the receiver's code shows ("Coin limit" line) -----------------------------------
    static final int OFFER_VERSION=1,OFFER_PHONES=4,PREFIX=6;
    /** perPayment as it applies now (stale cap included) and perPhoneDay. Version 1 could also list up to 4 paying
     *  phones; the first-contact intent replaced that list, so it is written empty and still read. */
    public static final class Offer {
        public final long perPayment,perPhoneDay;
        final List<byte[]> prefixes=new ArrayList<>();final List<Long> used=new ArrayList<>();
        Offer(long perPayment,long perPhoneDay){this.perPayment=perPayment;this.perPhoneDay=perPhoneDay;}
        /** What this payer may pay here now, from coins of these chains (atoms; Long.MAX_VALUE when nothing limits it). */
        public long room(Collection<byte[]> payerChains){
            long room=perPayment>0?perPayment:Long.MAX_VALUE;
            if(perPhoneDay>0)for(byte[] c:payerChains){
                long u=0;
                for(int i=0;i<prefixes.size();i++)if(Arrays.equals(prefixes.get(i),Arrays.copyOf(c,PREFIX)))u=used.get(i);
                room=Math.min(room,Math.max(0,perPhoneDay-u));
            }
            return room;
        }
    }
    /** The offer this receiver shows: its per-payment cap now and its day limit (18 bytes). */
    public byte[] offer(boolean stale){return new Out().u8(OFFER_VERSION).u64(paymentCap(stale)).u64(perPhoneDay).u8(0).bytes();}
    public static Offer parseOffer(byte[] b)throws R2Exception{
        In in=new In(b);
        if(in.u8()!=OFFER_VERSION)throw R2Codec.fail("parse","limit version");
        Offer f=new Offer(in.u64(),in.u64());
        if(f.perPayment<0||f.perPhoneDay<0)throw R2Codec.fail("parse","limit");
        int n=in.u8();if(n>OFFER_PHONES)throw R2Codec.fail("parse","limit phones");
        for(int i=0;i<n;i++){f.prefixes.add(in.raw(PREFIX));long u=in.u64();if(u<0)throw R2Codec.fail("parse","limit used");f.used.add(u);}
        in.end();
        return f;
    }
}
