// GHSA-qwgh-2vcv-g2f7 describes a cursor stored inside the data buffer. The
// digest 0.10 dependency uses block-buffer 0.10.4, whose cursor is a separate
// field. Exercise both callback paths before accepting that precise audit
// exception; later buffer implementations must use the upstream patched release.
use sha2::digest::block_buffer::{generic_array::typenum::U4, EagerBuffer};
use std::panic::{catch_unwind, AssertUnwindSafe};

#[test]
fn compression_panic_cannot_overwrite_the_separate_cursor() {
    let mut buffer = EagerBuffer::<U4>::new(&[1, 2]);
    let result = catch_unwind(AssertUnwindSafe(|| {
        buffer.digest_blocks(&[3, 0xff], |_| panic!("compression failed"));
    }));
    assert!(result.is_err());
    assert_eq!(buffer.get_pos(), 2);
    assert_eq!(buffer.get_data(), &[1, 2]);
    // Reuse after the caught panic is the condition required by the advisory.
    buffer.digest_blocks(&[4], |_| unreachable!());
    assert_eq!(buffer.get_data(), &[1, 2, 4]);
    buffer.reset();
    buffer.digest_blocks(&[5, 6], |_| unreachable!());
    assert_eq!(buffer.get_data(), &[5, 6]);
}

#[test]
fn generation_panic_cannot_overwrite_the_separate_cursor() {
    let mut buffer = EagerBuffer::<U4>::new(&[1]);
    let mut output = [0; 4];
    let result = catch_unwind(AssertUnwindSafe(|| {
        // The leftover path passes a temporary block to the generator; writing
        // its first byte cannot replace the cursor, unlike ReadBuffer 0.12.0.
        buffer.set_data(&mut output, |blocks| {
            if let Some(block) = blocks.first_mut() {
                block.fill(0xff);
                panic!("generation failed");
            }
        });
    }));
    assert!(result.is_err());
    assert_eq!(buffer.get_pos(), 1);
    assert_eq!(buffer.get_data(), &[1]);
    buffer.set_data(&mut output, |blocks| {
        for block in blocks {
            block.fill(7);
        }
    });
    assert_eq!(output, [0, 0, 0, 7]);
    assert_eq!(buffer.get_pos(), 1);
}
