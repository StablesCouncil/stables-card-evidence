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
 * The receiver enforces them when it checks a payment (R2Wallet.receive); it also tells payers, in its code, what it
 * will take (an Offer): a payer that reads it refuses a payment above it before signing anything, so no coin is ever
 * spent into a payment the receiver will refuse. Older phones ignore the line.
 */
public final class R2Limits {
    public static final long DAY_MS=24L*60*60*1000;
    /** A revocation list older than this caps received payments at the one-touch limit. */
    public static final long STALE_MS=30L*DAY_MS;
    public static final long DEFAULT_PER_PAYMENT=500L*R2Codec.ATOMS,DEFAULT_PER_PHONE_DAY=1000L*R2Codec.ATOMS,
            DEFAULT_STRONG_AT=100L*R2Codec.ATOMS,DEFAULT_ONE_TOUCH=50L*R2Codec.ATOMS;
    public static final String PAYMENT="payment",DAY="day",STALE="stale";

    public final long perPayment,perPhoneDay,strongAt,oneTouch;
    public R2Limits(long perPayment,long perPhoneDay,long strongAt,long oneTouch){
        if(perPayment<0||perPhoneDay<0||strongAt<0||oneTouch<0)throw new IllegalArgumentException("limits");
        this.perPayment=perPayment;this.perPhoneDay=perPhoneDay;this.strongAt=strongAt;this.oneTouch=oneTouch;
    }
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

    // ---- Offer: what the receiver tells payers in its code ("Coin limit" line) -------------------------------------
    static final int OFFER_VERSION=1,OFFER_PHONES=4,PREFIX=6;
    /** perPayment as it applies now (stale cap included), perPhoneDay, and what up to 4 paying phones used today. */
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
    /** The offer this receiver shows, with the phones that used the most of their day first. */
    public byte[] offer(Map<String,Long> usedToday,boolean stale){
        Out o=new Out().u8(OFFER_VERSION).u64(paymentCap(stale)).u64(perPhoneDay);
        List<Map.Entry<String,Long>> l=new ArrayList<>(usedToday.entrySet());
        l.sort((a,b)->Long.compare(b.getValue(),a.getValue()));
        int n=perPhoneDay>0?Math.min(OFFER_PHONES,l.size()):0;
        o.u8(n);
        for(int i=0;i<n;i++)o.raw(Arrays.copyOf(R2Codec.unhex(l.get(i).getKey()),PREFIX)).u64(l.get(i).getValue());
        return o.bytes();
    }
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
