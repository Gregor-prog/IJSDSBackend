import verify_payment from "../services/verify-payment.service.js"
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ROLE_KEY
);
//paystack controller
const paystackController = async (req,res) => {
    try {
    const {reference,amount,articleId} = req.body
        const checkTrans = await verify_payment(reference,amount)
        // console.log(checkTrans)
          if(checkTrans.status == true){
            const {data,error} = await supabase.from("articles")
            .update({vetting_fee : true})
            .eq('id',articleId)
            if(error){
                console.log(error)
            }
          }

        res.status(200).json({
            success:true,
            message:"payment confirmed",
            data:checkTrans
        })
    } catch (error) {
        console.log(error)
        if(error){
            res.status(404).json({
                success:false,
                message:"an error occured",
                data:error
            })
        }
    }
}

export default paystackController