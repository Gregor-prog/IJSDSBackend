import verify_payment from "../services/verify-payment.service.js"
//paystack controller
const paystackController = async (req,res) => {
    const {reference,amount} = req.body
    try {
        const checkTrans = await verify_payment(reference,amount)

        res.status(200).json({
            success:true,
            message:"payment confirmed",
            data:checkTrans
        })
    } catch (error) {
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