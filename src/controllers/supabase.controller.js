import fetchFile from "../services/getFile.service.js"

const getFile = async (req,res) => {
    const {fileUrl}  = req.body.url
    try {
        const buffer = await fetchFile(fileUrl)
        console.log(buffer)
        res.status(200).json({
            succcess:true,
            message:"buffer successfully fetched",
            data:buffer
        })
    } catch (error) {
        if(error){
            console.log(error)
            res.status(404).json({
                success:false,
                message:"an error occured, resource not found",
                error:error.message
            })
        }
    }
}

export default getFile