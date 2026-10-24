use super::{Listing, Native, Node};
pub struct Backend;
impl Native for Backend {
    type Element = ();
    fn new() -> Result<Self, String> {
        Err(
            "unsupported_platform: native controls require macOS or Windows; use screenshot tools"
                .into(),
        )
    }
    fn apps(&self) -> Result<Listing<()>, String> {
        unreachable!()
    }
    fn windows(&self, _: Option<&()>) -> Result<Listing<()>, String> {
        unreachable!()
    }
    fn inspect(&self, _: &()) -> Result<Node, String> {
        unreachable!()
    }
    fn children(&self, _: &(), _: usize) -> Result<(Vec<()>, bool), String> {
        unreachable!()
    }
    fn validate(&self, _: &(), _: Option<&()>) -> Result<(), String> {
        unreachable!()
    }
    fn activate(&self, _: &()) -> Result<bool, String> {
        unreachable!()
    }
    fn invoke(&self, _: &(), _: &str) -> Result<(), String> {
        unreachable!()
    }
    fn set_value(&self, _: &(), _: &str) -> Result<(), String> {
        unreachable!()
    }
    fn read(&self, _: &(), _: usize, _: usize) -> Result<(String, bool), String> {
        unreachable!()
    }
}
