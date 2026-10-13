package org.stablescouncil.stables.route2;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * R2T2 deposit proof (trace-design.md 13.11). A script limits how a coin is spent, never how it is created, so anyone can
 * make a dust "anchor" claiming any amount. An R2T2 anchor counts only when its creating transaction put the money in:
 * exactly one output at the anchor address (this coin), an output at the vault with the anchor's token and amount,
 * and no input from the vault or the anchor address (a payout cannot mint an anchor from its remainder).
 * Pure: the caller reads the transaction from its own node and hands it over in this neutral form.
 */
public final class R2Anchors {
    private R2Anchors(){}
    public static final class TxOut {
        public final String address,tokenid,tokenamount,coinid;public final boolean keepsState;
        public TxOut(String address,String tokenid,String tokenamount,String coinid,boolean keepsState){
            this.address=address;this.tokenid=tokenid;this.tokenamount=tokenamount;this.coinid=coinid;this.keepsState=keepsState;
        }
    }
    public static final class Tx {
        public final List<TxOut> outputs;public final List<String> inputAddresses;
        public Tx(List<TxOut> outputs,List<String> inputAddresses){this.outputs=new ArrayList<>(outputs);this.inputAddresses=new ArrayList<>(inputAddresses);}
        /** True when this transaction created the coin. */
        public boolean creates(String coinId){for(TxOut o:outputs)if(eq(o.coinid,coinId))return true;return false;}
    }

    public static boolean depositProven(String anchorCoinId,Tx tx,String anchorAddress,String vaultAddress,String amount,String token){
        if(tx==null||anchorAddress==null||vaultAddress==null||amount==null||token==null)return false;
        int anchors=0;boolean mine=false;
        for(TxOut o:tx.outputs)if(eq(o.address,anchorAddress)){anchors++;if(eq(o.coinid,anchorCoinId))mine=true;}
        if(anchors!=1||!mine)return false;
        for(String a:tx.inputAddresses)if(eq(a,vaultAddress)||eq(a,anchorAddress))return false;
        long want;try{want=R2Codec.atoms(amount.trim());}catch(Exception e){return false;}
        for(TxOut o:tx.outputs){
            // Whether the value keeps state does not matter: nothing reads a vault coin's state, and the phone's one-send
            // deposit (send multi) keeps state on every output.
            if(!eq(o.address,vaultAddress)||!eq(o.tokenid,token))continue;
            try{if(R2Codec.atoms(o.tokenamount.trim())==want)return true;}catch(Exception e){/* not an exact amount: not this output */}
        }
        return false;
    }
    static boolean eq(String a,String b){return a!=null&&b!=null&&norm(a).equals(norm(b));}
    static String norm(String h){String v=h.trim();if(v.startsWith("0x")||v.startsWith("0X"))v=v.substring(2);return v.toLowerCase(Locale.ROOT);}
}
