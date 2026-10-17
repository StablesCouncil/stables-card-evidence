package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.minima.objects.Transaction;
import org.minima.objects.base.MiniData;

/**
 * Generation R2T4 (DEPOSIT_PROOF_DESIGN.md, founder 2026-10-17): card deposits that prove themselves at any age.
 *
 * Every R2T4 deposit spends one lane coin of the deposit gate as its FIRST input, and the gate's script enforces the
 * whole transaction: output 0 the next lane coin, output 1 the marker at the anchor address, output 2 the amount into
 * the vault, the deposit number (port 5) one above the lane coin's own. Minima derives a new coin's id from the first
 * input's coin id and the output index (TxBlock: hash(first input coin id, index)), so each lane is one chain of ids
 * that anyone can compute from its published genesis coin:
 *
 *   L(lane, 0) = the genesis coin id;   L(lane, n) = hash(L(lane, n-1), 0);   marker of deposit n = hash(L(lane, n-1), 1).
 *
 * A marker is genuine exactly when its coin id is that value for the lane and number in its own ports 6 and 5: the
 * money into the vault was enforced by the chain when the deposit was made, so no old transaction is ever read.
 */
public final class R2Deposits {
    public static final String GENERATION_R2T4="0x52325434";
    /** The deposit gate's address: the hash of its clean script (contracts/deployed/r2t4_gate). */
    public static final String GATE="0x084B1E939F497E46EA5107D3B29CB82E8E547FED26EDE45984FC3890352B7CC3";
    /** The gate's lanes on Minima mainnet: their genesis coins (port 5 = 0, port 6 = the lane), blocks 2,371,091 and 2,371,093. */
    public static final Map<Integer,String> LANES;
    static{
        Map<Integer,String> m=new java.util.LinkedHashMap<>();
        m.put(1,"0xEDD47A48D22EE92992D9D3BF6FD0761E6272417C0DEEE4FE640DF3A875890167");
        m.put(2,"0xB30C91D504B80D39E5E34C286C6F6DB64176C96D994796FF80D93C487C574CE4");
        m.put(3,"0x6DA136F11EBA61F1D04669AD4087B60B7E1193A310A5998F674EC51248371679");
        m.put(4,"0x494D8AFF5F7DB3A82A8589C7FBA97082FC9F212BD8388081A720B99DBB54CDCF");
        m.put(5,"0xD09FD59919CB708A674A5DA2724F985D93F209A199C8309D46245048FD7A76D7");
        m.put(6,"0x81730FA814DB79B1C749659969C2E532EFF90513FEB95C88DF1F9E5226BF55CF");
        m.put(7,"0x40AFA8EBD249FD810A59E322CB193BF6376D141D3AC9A6D454E495936E5AC934");
        m.put(8,"0xE3D39D739A1844C0D54FA0CF0550B7A0EE21980D366F80BAA133FD07C2E45C38");
        LANES=java.util.Collections.unmodifiableMap(m);
    }
    /** The mainnet gate. */
    public static R2Deposits mainnet(){return new R2Deposits(LANES);}
    /** The highest deposit number a marker may claim: bounds the hashing a forged port 5 could ask for. */
    public static final long MAX_DEPOSITS=10_000_000L;

    private final Map<Integer,byte[]> genesis=new HashMap<>();
    /** Per lane, the links computed so far: index k holds L(lane, k). */
    private final Map<Integer,List<byte[]>> links=new HashMap<>();

    /** lanes: lane number to its genesis coin id (0x hex). */
    public R2Deposits(Map<Integer,String> lanes){
        for(Map.Entry<Integer,String> e:lanes.entrySet()){
            byte[] g=R2Codec.unhex(e.getValue().trim().replaceFirst("^0[xX]",""));
            if(g.length!=32)throw new IllegalArgumentException("genesis coin id of lane "+e.getKey());
            genesis.put(e.getKey(),g.clone());
        }
    }
    public boolean hasLanes(){return !genesis.isEmpty();}

    /** Minima's own coin id of output `index` of a transaction whose first input is `base`. */
    public static byte[] coinId(byte[] base,int index){
        return new Transaction().calculateCoinID(new MiniData(base),index).getBytes();
    }

    /** L(lane, k), or null for an unknown lane. */
    synchronized byte[] link(int lane,long k){
        byte[] g=genesis.get(lane);if(g==null||k<0)return null;
        List<byte[]> l=links.get(lane);
        if(l==null){l=new ArrayList<>();l.add(g);links.put(lane,l);}
        while(l.size()<=k)l.add(coinId(l.get(l.size()-1),0));
        return l.get((int)k);
    }

    /** The id the marker of deposit n on this lane must have, or null for an unknown lane or n out of range. */
    public byte[] markerId(int lane,long n){
        if(n<1||n>MAX_DEPOSITS)return null;
        byte[] prev=link(lane,n-1);
        return prev==null?null:coinId(prev,1);
    }

    /** Throws unless this coin is the genuine marker its own ports (5 the deposit number, 6 the lane) name. */
    public void check(byte[] markerCoinId,Map<Integer,String> state)throws R2Codec.R2Exception{
        if(state==null)throw R2Codec.fail("anchor-deposit","R2T4 marker without state");
        int lane;long n;
        try{lane=Integer.parseInt(state.get(6).trim());n=Long.parseLong(state.get(5).trim());}
        catch(RuntimeException e){throw R2Codec.fail("anchor-deposit","R2T4 marker: lane or deposit number unreadable");}
        if(!genesis.containsKey(lane))throw R2Codec.fail("anchor-deposit","R2T4 marker names lane "+lane+", which is not published");
        byte[] want=markerId(lane,n);
        if(want==null)throw R2Codec.fail("anchor-deposit","R2T4 marker: deposit number "+n+" out of range");
        if(!Arrays.equals(want,markerCoinId))throw R2Codec.fail("anchor-deposit","not a deposit through the gate: lane "+lane+" deposit "+n+" would be "+R2Codec.hex(want).toUpperCase(Locale.ROOT));
    }
}
